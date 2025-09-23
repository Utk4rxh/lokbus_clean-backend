const { Router } = require("express");
const router = Router();
const BusStation = require("../models/BusStation");

// GET station by ID
router.get("/:id", async (req, res) => {
  try {
    const station = await BusStation.findById(req.params.id)
      .select("name code location address facilities operatingHours routes createdAt updatedAt");

    if (!station) {
      return res.status(404).json({ error: "Station not found" });
    }

    res.json(station);
  } catch (err) {
    console.error("Error fetching station details:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;