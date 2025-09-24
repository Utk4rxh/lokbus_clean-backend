require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const connectDB = require("./config/db");

const { authenticateToken } = require("./middlewares/auth");

const authRoutes = require("./routes/auth");
const queryRoutes = require("./routes/query");
const liveTrackingRoutes = require("./routes/livetracking");

const Trip = require("./models/Trip");
const { shouldSave } = require("./utils/rateLimiter");
const { haversineMeters } = require("./utils/geo");

const app = express();
const PORT = process.env.PORT || 8000;

// Store active driver tracking intervals and their socket references
const driverSessions = new Map(); // tripId -> { socket, interval }

// Ensure required environment variables are set
const requiredEnvVars = ["MONGO_URI", "JWT_SECRET"];
const missingEnvVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnvVars.join(", ")}`
  );
  process.exit(1);
}

// CORS options
const corsOptions = {
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
};

app.use(cors(corsOptions));
app.use(cookieParser());
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    features: {
      tripPlanner: true,
      liveTracking: true,
      busStations: true,
    },
  });
});

// Public routes
app.use("/auth", authRoutes);

// Protected API routes
app.use("/query", authenticateToken, queryRoutes);
app.use("/live-tracking", authenticateToken, liveTrackingRoutes);

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Function to start location request timer for a driver
function startLocationRequests(socket, tripId) {
  // Clear any existing session for this trip
  if (driverSessions.has(tripId)) {
    const existingSession = driverSessions.get(tripId);
    clearInterval(existingSession.interval);
  }
  console.log(`Starting location requests for trip ${tripId}`);

  // Request location from Flutter app every 5 seconds
  const interval = setInterval(() => {
    // Ask Flutter app to send current location
    socket.emit("request-location", { 
      tripId,
      timestamp: Date.now(),
      message: "Please send current GPS location"
    });
  }, 5000); // Request every 5 seconds

  driverSessions.set(tripId, { socket, interval });
}

// Function to stop location requests for a driver
function stopLocationRequests(tripId) {
  if (driverSessions.has(tripId)) {
    const session = driverSessions.get(tripId);
    clearInterval(session.interval);
    driverSessions.delete(tripId);
    console.log(`Stopped location requests for trip ${tripId}`);
  }
}

(async () => {
  try {
    await connectDB(process.env.MONGO_URI);

    io.on("connection", (socket) => {
      console.log("Socket connected:", socket.id);

      // Add error handler for the socket to prevent crashes
      socket.on("error", (err) => {
        console.error("Socket error:", err);
      });

      // Driver starts trip - begins requesting location from Flutter
      socket.on("start-driver-trip", async ({ tripId }) => {
        try {
          if (!tripId) {
            return socket.emit("server-error", { message: "Trip ID is required" });
          }

          const trip = await Trip.findById(tripId)
            .populate("bus", "regNo model")
            .populate("route", "name code")
            .populate("driver", "name")
            .lean();
          
          if (!trip) {
            return socket.emit("server-error", { message: "Trip not found" });
          }

          // Join the trip room
          socket.join(`trip:${tripId}`);
          socket.join(`driver:${tripId}`);

          // Start requesting location from Flutter app
          startLocationRequests(socket, tripId);

          socket.emit("driver-trip-started", {
            tripId: trip._id,
            bus: trip.bus,
            route: trip.route,
            driver: trip.driver,
            status: "tracking-started",
            message: "Location tracking started - Flutter app will be requested for GPS every 5 seconds"
          });

          console.log(`Driver started trip ${tripId} - requesting location from Flutter app`);
        } catch (err) {
          console.error("Start driver trip error:", err);
          socket.emit("server-error", { message: "Failed to start driver trip" });
        }
      });

      // Driver stops trip - stops requesting location
      socket.on("stop-driver-trip", async ({ tripId }) => {
        try {
          if (!tripId) {
            return socket.emit("server-error", { message: "Trip ID is required" });
          }

          // Stop location requests
          stopLocationRequests(tripId);

          // Leave rooms
          socket.leave(`trip:${tripId}`);
          socket.leave(`driver:${tripId}`);

          // Update trip status to finished
          await Trip.findByIdAndUpdate(tripId, {
            status: "finished",
            endedAt: new Date(),
          });

          socket.emit("driver-trip-stopped", {
            tripId,
            status: "tracking-stopped",
            message: "Location tracking stopped"
          });

          // Notify all room members that trip has ended
          io.to(`trip:${tripId}`).emit("trip-ended", { tripId });

          console.log(`Driver stopped trip ${tripId}`);
        } catch (err) {
          console.error("Stop driver trip error:", err);
          socket.emit("server-error", { message: "Failed to stop driver trip" });
        }
      });

      // Flutter app sends location update (in response to request-location or manually)
      socket.on("location-update", async (data) => {
        try {
          const { tripId, lat, lng, ts, speed, bearing, accuracy } = data || {};
          
          if (!tripId || lat == null || lng == null) {
            return socket.emit("server-error", {
              message: "Trip ID, latitude, and longitude are required",
            });
          }
          
          if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            return socket.emit("server-error", { message: "Invalid coordinates" });
          }

          // Check if utilities exist
          if (typeof shouldSave !== "function" || typeof haversineMeters !== "function") {
            return socket.emit("server-error", { message: "Location utilities not available" });
          }

          const coords = [Number(lng), Number(lat)];
          const nowTs = Date.now();
          const minSec = Number(process.env.SAVE_LOCATION_MIN_SECONDS || 5);
          const minMeters = Number(process.env.SAVE_LOCATION_MIN_METERS || 30);

          const locationData = {
            tripId,
            lat: Number(lat),
            lng: Number(lng),
            ts: ts || nowTs,
            speed: speed != null ? Number(speed) : null,
            bearing: bearing != null ? Number(bearing) : null,
            accuracy: accuracy != null ? Number(accuracy) : null,
          };

          // Always broadcast to interested rooms for real-time tracking
          io.to(`trip:${tripId}`).emit("location", locationData);
          io.to(`track:${tripId}`).emit("bus-location", locationData);

          // Save to database only if conditions are met
          if (shouldSave(tripId, nowTs, coords, minSec, minMeters, haversineMeters)) {
            const locObj = {
              ts: ts ? new Date(Number(ts)) : new Date(),
              coords: { type: "Point", coordinates: coords },
              speed: speed != null ? Number(speed) : null,
              bearing: bearing != null ? Number(bearing) : null,
            };
            
            const updateResult = await Trip.findByIdAndUpdate(tripId, {
              $push: { locations: locObj },
              $set: {
                lastLocation: { type: "Point", coordinates: coords },
                updatedAt: new Date(),
              },
            });
            
            if (updateResult) {
              // Notify driver that location was saved
              socket.emit("location-saved", {
                saved: true,
                timestamp: locObj.ts,
                accuracy: accuracy
              });
              
              // Broadcast database update to trackers
              io.to(`track:${tripId}`).emit("location-update", {
                tripId,
                lastLocation: { type: "Point", coordinates: coords },
                timestamp: locObj.ts,
              });
              
              console.log(`Location saved for trip ${tripId}: ${lat}, ${lng} (accuracy: ${accuracy}m)`);
            } else {
              socket.emit("server-error", { message: "Trip not found" });
            }
          } else {
            // Still notify driver even if not saved
            socket.emit("location-saved", {
              saved: false,
              reason: "rate-limited",
            });
          }
        } catch (err) {
          console.error("Location update error:", err);
          socket.emit("server-error", { message: "Failed to save location" });
        }
      });

      // Passengers/Users join trip to track bus location
      socket.on("join-trip", async ({ tripId }) => {
        try {
          if (!tripId) {
            return socket.emit("server-error", { message: "Trip ID is required" });
          }

          const trip = await Trip.findById(tripId)
            .populate("bus", "regNo model")
            .populate("route", "name code")
            .populate("driver", "name")
            .lean();
          
          if (!trip) {
            return socket.emit("server-error", { message: "Trip not found" });
          }

          socket.join(`trip:${tripId}`);

          socket.emit("trip-joined", {
            tripId: trip._id,
            tripDetails: {
              _id: trip._id,
              bus: trip.bus,
              route: trip.route,
              driver: trip.driver,
              status: trip.status,
              startedAt: trip.startedAt,
            },
            lastLocation: trip.lastLocation,
            recentLocations: trip.locations?.slice(-10) || [],
            message: "Joined trip - you will receive real-time location updates"
          });

          console.log(`User joined trip ${tripId} for tracking`);
        } catch (err) {
          console.error("Join trip error:", err);
          socket.emit("server-error", { message: "Failed to join trip" });
        }
      });

      // Track trip details (for detailed tracking view)
      socket.on("track-trip", async ({ tripId }) => {
        try {
          if (!tripId) {
            return socket.emit("server-error", { message: "Trip ID is required" });
          }
          
          const trip = await Trip.findById(tripId)
            .populate("bus", "regNo model capacity")
            .populate({
              path: "route",
              populate: { path: "stops.station", select: "name code location" },
            })
            .populate("driver", "name")
            .lean();
          
          if (!trip) {
            return socket.emit("server-error", { message: "Trip not found" });
          }

          socket.join(`track:${tripId}`);
          
          socket.emit("trip-tracking-init", {
            tripId: trip._id,
            status: trip.status,
            bus: trip.bus,
            route: trip.route,
            driver: trip.driver,
            lastLocation: trip.lastLocation,
            startedAt: trip.startedAt,
            recentLocations: trip.locations?.slice(-5) || [],
          });
        } catch (err) {
          console.error("Track trip error:", err);
          socket.emit("server-error", { message: "Failed to start tracking trip" });
        }
      });

      // Track all ongoing trips on a route
      socket.on("track-route", async ({ routeId }) => {
        try {
          if (!routeId) {
            return socket.emit("server-error", { message: "Route ID is required" });
          }
          
          socket.join(`route:${routeId}`);
          
          const activeTrips = await Trip.find({
            route: routeId,
            status: "ongoing",
            lastLocation: { $exists: true },
          })
            .populate("bus", "regNo model")
            .populate("driver", "name")
            .select("_id lastLocation startedAt")
            .lean();
          
          socket.emit("route-tracking-init", {
            routeId,
            activeTrips: activeTrips.map((t) => ({
              tripId: t._id,
              bus: t.bus,
              driver: t.driver,
              lastLocation: t.lastLocation,
              startedAt: t.startedAt,
            })),
          });
        } catch (err) {
          console.error("Track route error:", err);
          socket.emit("server-error", { message: "Failed to start tracking route" });
        }
      });

      // Leave trip room
      socket.on("leave-trip", ({ tripId }) => {
        if (tripId) {
          socket.leave(`trip:${tripId}`);
          socket.leave(`track:${tripId}`);
          socket.leave(`driver:${tripId}`);
          console.log(`User left trip ${tripId}`);
        }
      });

      // Stop tracking
      socket.on("stop-tracking", ({ tripId, routeId }) => {
        if (tripId) {
          socket.leave(`track:${tripId}`);
          socket.leave(`trip:${tripId}`);
        }
        if (routeId) socket.leave(`route:${routeId}`);
      });

      socket.on("disconnect", () => {
        console.log("Socket disconnected:", socket.id);
        
        // Clean up any driver sessions for this socket
        for (const [tripId, session] of driverSessions.entries()) {
          if (session.socket === socket) {
            stopLocationRequests(tripId);
            console.log(`Cleaned up location requests for trip ${tripId} due to disconnect`);
          }
        }
      });
    });

    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Server startup error:", err);
    process.exit(1);
  }
})();