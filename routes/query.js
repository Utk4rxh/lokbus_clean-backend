const { Router } = require("express");
const router = Router();
const {
  getNearby,
  getByRoute,
  getDirections,
} = require("../controllers/queryController");

// Nearby stations
router.get("/nearby", getNearby);

// Trips by route
router.get("/route/:routeId", getByRoute);

// Directions to a bus station
router.get("/directions/:stationId", getDirections);

module.exports = router;