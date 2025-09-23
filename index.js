require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const connectDB = require("./config/db");

const { authenticateToken } = require("./middlewares/auth");

// Routes
const authRoutes = require("./routes/auth");
const queryRoutes = require("./routes/query");
const stationRoutes = require("./routes/stations");
const liveTrackingRoutes = require("./routes/livetracking");

const Trip = require("./models/Trip");
const { shouldSave } = require("./utils/rateLimiter");
const { haversineMeters } = require("./utils/geo");

const app = express();
const PORT = process.env.PORT || 8000;

// ✅ Ensure required environment variables
const requiredEnvVars = ["MONGO_URI", "JWT_SECRET"];
const missingEnvVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnvVars.join(", ")}`
  );
  process.exit(1);
}

// ✅ Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || "*", credentials: true }));
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ✅ Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    features: {
      tripPlanner: true,
      liveTracking: true,
      busStations: true,
      directions: true,
    },
  });
});

// ✅ Public routes
app.use("/auth", authRoutes);

// ✅ Protected routes
app.use("/query", authenticateToken, queryRoutes);
app.use("/stations", authenticateToken, stationRoutes);
app.use("/live-tracking", authenticateToken, liveTrackingRoutes);

// ✅ 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ✅ Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ✅ HTTP + Socket.IO server
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// 🔹 Utility function to check ObjectId
const isObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

(async () => {
  try {
    await connectDB(process.env.MONGO_URI);

    io.on("connection", (socket) => {
      console.log("🔌 Socket connected:", socket.id);

      // ---------------- JOIN TRIP ----------------
      socket.on("join-trip", async ({ tripId }) => {
        if (!tripId) return socket.emit("error", { message: "Trip ID required" });

        socket.join(`trip:${tripId}`);

        try {
          let trip;
          if (isObjectId(tripId)) {
            trip = await Trip.findById(tripId)
              .populate("bus", "regNo model")
              .populate("route", "name code")
              .lean();
          } else {
            trip = await Trip.findOne({ code: tripId })
              .populate("bus", "regNo model")
              .populate("route", "name code")
              .lean();
          }

          if (trip?.lastLocation?.coordinates) {
            socket.emit("trip-init", {
              tripDetails: {
                _id: trip._id,
                code: trip.code,
                bus: trip.bus,
                route: trip.route,
                status: trip.status,
                startedAt: trip.startedAt,
              },
              lastLocation: trip.lastLocation,
              locations: trip.locations?.slice(-10) || [],
            });
          } else {
            socket.emit("error", { message: "Trip not found or no location yet" });
          }
        } catch (err) {
          console.error("❌ Join trip error:", err);
          socket.emit("error", { message: "Failed to join trip" });
        }
      });

      // ---------------- LOCATION UPDATE ----------------
      socket.on("location-update", async (data) => {
        const { tripId, lat, lng, ts, speed, bearing } = data;
        if (!tripId || lat == null || lng == null) {
          return socket.emit("error", {
            message: "Trip ID, latitude, longitude required",
          });
        }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return socket.emit("error", { message: "Invalid coordinates" });
        }

        const coords = [Number(lng), Number(lat)];
        const nowTs = Date.now();
        const minSec = Number(process.env.SAVE_LOCATION_MIN_SECONDS || 5);
        const minMeters = Number(process.env.SAVE_LOCATION_MIN_METERS || 30);

        const locationData = {
          tripId,
          lat: Number(lat),
          lng: Number(lng),
          ts: ts || Date.now(),
          speed: speed != null ? Number(speed) : null,
          bearing: bearing != null ? Number(bearing) : null,
        };

        io.to(`trip:${tripId}`).emit("location", locationData);
        io.to(`track:${tripId}`).emit("bus-location", locationData);

        try {
          if (
            shouldSave(tripId, nowTs, coords, minSec, minMeters, haversineMeters)
          ) {
            const locObj = {
              ts: ts ? new Date(ts) : new Date(),
              coords: { type: "Point", coordinates: coords },
              speed: speed != null ? Number(speed) : null,
              bearing: bearing != null ? Number(bearing) : null,
            };

            let updateResult;
            if (isObjectId(tripId)) {
              updateResult = await Trip.findByIdAndUpdate(tripId, {
                $push: { locations: locObj },
                $set: {
                  lastLocation: { type: "Point", coordinates: coords },
                  updatedAt: new Date(),
                },
              });
            } else {
              updateResult = await Trip.findOneAndUpdate(
                { code: tripId },
                {
                  $push: { locations: locObj },
                  $set: {
                    lastLocation: { type: "Point", coordinates: coords },
                    updatedAt: new Date(),
                  },
                }
              );
            }

            if (updateResult) {
              socket.emit("location-saved", { saved: true, timestamp: locObj.ts });
              io.to(`track:${tripId}`).emit("location-update", {
                tripId,
                lastLocation: { type: "Point", coordinates: coords },
                timestamp: locObj.ts,
              });
            } else {
              socket.emit("error", { message: "Trip not found" });
            }
          } else {
            socket.emit("location-saved", { saved: false, reason: "rate-limited" });
          }
        } catch (err) {
          console.error("❌ Location update error:", err);
          socket.emit("error", { message: "Failed to save location" });
        }
      });

      // ---------------- TRACK TRIP ----------------
      socket.on("track-trip", async ({ tripId }) => {
        if (!tripId) return socket.emit("error", { message: "Trip ID required" });

        socket.join(`track:${tripId}`);

        try {
          let trip;
          if (isObjectId(tripId)) {
            trip = await Trip.findById(tripId)
              .populate("bus", "regNo model capacity")
              .populate({
                path: "route",
                populate: { path: "stops.station", select: "name code location" },
              })
              .populate("driver", "name")
              .lean();
          } else {
            trip = await Trip.findOne({ code: tripId })
              .populate("bus", "regNo model capacity")
              .populate({
                path: "route",
                populate: { path: "stops.station", select: "name code location" },
              })
              .populate("driver", "name")
              .lean();
          }

          if (trip) {
            socket.emit("trip-tracking-init", {
              tripId: trip._id,
              code: trip.code,
              status: trip.status,
              bus: trip.bus,
              route: trip.route,
              driver: trip.driver,
              lastLocation: trip.lastLocation,
              startedAt: trip.startedAt,
              recentLocations: trip.locations?.slice(-5) || [],
            });
          } else {
            socket.emit("error", { message: "Trip not found" });
          }
        } catch (err) {
          console.error("❌ Track trip error:", err);
          socket.emit("error", { message: "Failed to track trip" });
        }
      });

      // ---------------- TRACK ROUTE ----------------
      socket.on("track-route", async ({ routeId }) => {
        if (!routeId) return socket.emit("error", { message: "Route ID required" });

        socket.join(`route:${routeId}`);
        try {
          const activeTrips = await Trip.find({
            route: routeId,
            status: "ongoing",
            lastLocation: { $exists: true },
          })
            .populate("bus", "regNo model")
            .populate("driver", "name")
            .select("_id code lastLocation startedAt")
            .lean();

          socket.emit("route-tracking-init", {
            routeId,
            activeTrips: activeTrips.map((t) => ({
              tripId: t._id,
              code: t.code,
              bus: t.bus,
              driver: t.driver,
              lastLocation: t.lastLocation,
              startedAt: t.startedAt,
            })),
          });
        } catch (err) {
          console.error("❌ Track route error:", err);
          socket.emit("error", { message: "Failed to track route" });
        }
      });

      // ---------------- STOP TRACKING ----------------
      socket.on("stop-tracking", ({ tripId, routeId }) => {
        if (tripId) socket.leave(`track:${tripId}`);
        if (routeId) socket.leave(`route:${routeId}`);
      });

      socket.on("leave-trip", ({ tripId }) => {
        if (tripId) {
          socket.leave(`trip:${tripId}`);
          socket.leave(`track:${tripId}`);
        }
      });

      socket.on("disconnect", () => {
        console.log("❌ Socket disconnected:", socket.id);
      });
    });

    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Server startup error:", err);
    process.exit(1);
  }
})();