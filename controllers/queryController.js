const Trip = require("../models/Trip");
const Route = require("../models/Route");
const BusStation = require("../models/BusStation");
const axios = require("axios");


// ✅ Get all active bus stations near a point (lng, lat) within radius meters
async function getNearby(req, res) {
  try {
    const { lng, lat, radius = 1000 } = req.query;

    if (!lng || !lat) {
      return res.status(400).json({ error: "Longitude and latitude are required" });
    }

    const longitude = parseFloat(lng);
    const latitude = parseFloat(lat);

    console.log(`Searching stations near lng: ${longitude}, lat: ${latitude}, radius: ${radius}m`);

    const stations = await BusStation.find({
      isActive: true,
      location: {
        $nearSphere: {
          $geometry: {
            type: "Point",
            coordinates: [longitude, latitude],
          },
          $maxDistance: parseInt(radius),
        },
      },
    }).select("name code location address");

    res.json({ count: stations.length, stations });
  } catch (error) {
    console.error("Error getting nearby stations:", error);
    res.status(500).json({ error: "Server error" });
  }
}


// ✅ Basic list of ongoing trips by route
async function getByRoute(req, res) {
  try {
    const { routeId } = req.params;
    const trips = await Trip.find({ route: routeId, status: "ongoing" })
      .populate("bus driver");

    res.json({ trips });
  } catch (err) {
    console.error("Error in getByRoute:", err);
    res.status(500).json({ error: "Server error" });
  }
}


// ✅ Get route directions to a specific bus station using OSRM
async function getDirections(req, res) {
  try {
    const { stationId } = req.params;
    const { lng, lat, mode = "driving" } = req.query;

    if (!lng || !lat) {
      return res.status(400).json({ error: "User latitude and longitude are required" });
    }

    const longitude = parseFloat(lng);
    const latitude = parseFloat(lat);

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: "Invalid coordinates" });
    }

    // 🔹 Find the destination station
    const station = await BusStation.findById(stationId).select("name code location address");
    if (!station) {
      return res.status(404).json({ error: "Bus station not found" });
    }

    // 🔹 Origin = user, Destination = station
    const origin = `${longitude},${latitude}`;
    const destination = `${station.location.coordinates[0]},${station.location.coordinates[1]}`;

    // 🔹 Call OSRM API
    const osrmUrl = `http://router.project-osrm.org/route/v1/${mode}/${origin};${destination}`;
    const params = {
      overview: "full",
      geometries: "geojson",
      steps: true,
    };

    console.log(`OSRM Directions API: ${osrmUrl}`);

    const response = await axios.get(osrmUrl, { params });

    if (!response.data.routes || response.data.routes.length === 0) {
      return res.status(400).json({ error: "Could not calculate route" });
    }

    const route = response.data.routes[0];
    const leg = route.legs[0];

    // 🔹 Response format
    const routeData = {
      station: {
        id: station._id,
        name: station.name,
        code: station.code,
        location: station.location,
        address: station.address,
      },
      route: {
        geometry: route.geometry, // GeoJSON polyline
        distance: {
          text: (route.distance / 1000).toFixed(2) + " km",
          value: route.distance,
        },
        duration: {
          text: Math.round(route.duration / 60) + " mins",
          value: route.duration,
        },
        steps: leg.steps.map((step) => ({
          distance: step.distance,
          duration: step.duration,
          name: step.name,
          mode: step.mode,
          maneuver: step.maneuver,
          geometry: step.geometry,
        })),
      },
      requestedAt: new Date().toISOString(),
    };

    console.log(`OSRM Route: ${route.distance}m, ${route.duration}s`);
    res.json(routeData);
  } catch (error) {
    console.error("Error getting directions (OSRM):", error.message);
    res.status(500).json({ error: "Server error" });
  }
}


// ✅ Export all functions
module.exports = {
  getNearby,
  getByRoute,
  getDirections,
};