const express = require("express");
const router = express.Router();
const LiveTrackingController = require("../controllers/livetrackingcontroller");

// Live tracking routes
router.get("/buses", LiveTrackingController.getBusesOnRoute);
router.get("/bus/:tripId", LiveTrackingController.getBusLiveTracking);

module.exports = router;