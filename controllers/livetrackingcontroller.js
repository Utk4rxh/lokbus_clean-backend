const Trip = require("../models/Trip");
const Route = require("../models/Route");
const BusStation = require("../models/BusStation");
const Bus = require("../models/Bus");

class LiveTrackingController {

  static async getBusesOnRoute(req, res) {
    try {
      const { from, to } = req.query;

      if (!from || !to) {
        return res.status(400).json({ 
          error: "Both 'from' and 'to' parameters are required" 
        });
      }

      // Find stations
      const [fromStations, toStations] = await Promise.all([
        BusStation.find({
          $or: [
            { name: { $regex: from, $options: 'i' } },
            { code: from.toUpperCase() }
          ],
          isActive: true
        }).limit(3),
        BusStation.find({
          $or: [
            { name: { $regex: to, $options: 'i' } },
            { code: to.toUpperCase() }
          ],
          isActive: true
        }).limit(3)
      ]);

      if (fromStations.length === 0 || toStations.length === 0) {
        return res.status(404).json({ 
          error: "One or both stations not found" 
        });
      }

      const busesData = [];

      // Find routes connecting these stations
      for (const fromStation of fromStations) {
        for (const toStation of toStations) {
          const routes = await Route.find({
            "stops.station": { $all: [fromStation._id, toStation._id] },
            isActive: true
          }).populate("stops.station", "name code location");

          for (const route of routes) {
            // Find active trips on this route
            const activeTrips = await Trip.find({
              route: route._id,
              status: "ongoing",
              lastLocation: { $exists: true }
            })
            .populate("bus", "regNo model capacity")
            .populate("driver", "name phone")
            .lean();

            for (const trip of activeTrips) {
              // Calculate which segment the bus is currently on
              const currentSegment = await LiveTrackingController.calculateCurrentSegment(
                trip, route
              );

              busesData.push({
                tripId: trip._id,
                bus: trip.bus,
                driver: trip.driver,
                route: {
                  _id: route._id,
                  name: route.name,
                  code: route.code
                },
                currentLocation: trip.lastLocation,
                currentSegment,
                startedAt: trip.startedAt,
                estimatedArrival: LiveTrackingController.calculateETA(
                  trip, route, toStation._id
                )
              });
            }
          }
        }
      }

      // Remove duplicates based on tripId
      const uniqueBuses = busesData.filter((bus, index, self) =>
        index === self.findIndex(b => b.tripId.toString() === bus.tripId.toString())
      );

      // Sort by estimated arrival time
      uniqueBuses.sort((a, b) => {
        if (a.estimatedArrival && b.estimatedArrival) {
          return new Date(a.estimatedArrival) - new Date(b.estimatedArrival);
        }
        return 0;
      });

      res.json({
        success: true,
        from: from,
        to: to,
        buses: uniqueBuses,
        count: uniqueBuses.length
      });

    } catch (error) {
      console.error("Get buses on route error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  // Get live location and details of a specific bus
  static async getBusLiveTracking(req, res) {
    try {
      const { tripId } = req.params;

      const trip = await Trip.findById(tripId)
        .populate("bus", "regNo model capacity")
        .populate("driver", "name phone")
        .populate({
          path: "route",
          populate: {
            path: "stops.station",
            select: "name code location address"
          }
        });

      if (!trip) {
        return res.status(404).json({ error: "Trip not found" });
      }

      if (trip.status !== "ongoing") {
        return res.status(400).json({ error: "Trip is not currently active" });
      }

      // Get recent location history
      const recentLocations = trip.locations.slice(-20); // Last 20 locations

      // Calculate current segment and progress
      const currentSegment = await LiveTrackingController.calculateCurrentSegment(
        trip, trip.route
      );

      // Find nearby bus stops
      const nearbyStops = await LiveTrackingController.findNearbyStops(
        trip.lastLocation, trip.route._id
      );

      // Calculate speed and bearing from recent locations
      const { speed, bearing } = LiveTrackingController.calculateSpeedAndBearing(
        recentLocations
      );

      res.json({
        success: true,
        trip: {
          _id: trip._id,
          status: trip.status,
          startedAt: trip.startedAt
        },
        bus: trip.bus,
        driver: trip.driver,
        route: trip.route,
        liveTracking: {
          currentLocation: trip.lastLocation,
          lastUpdated: trip.updatedAt,
          currentSegment,
          nearbyStops,
          recentLocations,
          speed,
          bearing,
          progress: currentSegment?.progress || 0
        }
      });

    } catch (error) {
      console.error("Get bus live tracking error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  // Helper method to calculate current segment
  static async calculateCurrentSegment(trip, route) {
    if (!trip.lastLocation || !route) return null;

    try {
      // If route is just an ID, fetch it
      if (!route.stops) {
        route = await Route.findById(route._id || route)
          .populate("stops.station", "name location");
      }

      if (!route.stops || route.stops.length < 2) return null;

      const currentCoords = trip.lastLocation.coordinates;
      let closestSegment = null;
      let minDistance = Infinity;

      // Find the closest segment
      for (let i = 0; i < route.stops.length - 1; i++) {
        const stopA = route.stops[i];
        const stopB = route.stops[i + 1];

        if (!stopA.station?.location || !stopB.station?.location) continue;

        const distance = LiveTrackingController.pointToSegmentDistance(
          currentCoords,
          stopA.station.location.coordinates,
          stopB.station.location.coordinates
        );

        if (distance < minDistance) {
          minDistance = distance;
          
          // Calculate progress along this segment
          const progress = LiveTrackingController.calculateSegmentProgress(
            currentCoords,
            stopA.station.location.coordinates,
            stopB.station.location.coordinates
          );

          closestSegment = {
            segmentIndex: i,
            fromStop: {
              _id: stopA.station._id,
              name: stopA.station.name,
              sequence: stopA.sequence
            },
            toStop: {
              _id: stopB.station._id,
              name: stopB.station.name,
              sequence: stopB.sequence
            },
            progress: Math.max(0, Math.min(100, progress)),
            distanceToSegment: Math.round(distance)
          };
        }
      }

      return closestSegment;
    } catch (error) {
      console.error("Calculate current segment error:", error);
      return null;
    }
  }

  // Helper method to find nearby stops
  static async findNearbyStops(currentLocation, routeId, radius = 500) {
    if (!currentLocation) return [];

    try {
      const route = await Route.findById(routeId)
        .populate("stops.station", "name code location address");

      if (!route) return [];

      const nearbyStops = [];
      const currentCoords = currentLocation.coordinates;

      for (const stop of route.stops) {
        if (!stop.station?.location) continue;

        const distance = LiveTrackingController.calculateDistance(
          currentCoords,
          stop.station.location.coordinates
        );

        if (distance <= radius) {
          nearbyStops.push({
            ...stop.toJSON(),
            distance: Math.round(distance)
          });
        }
      }

      return nearbyStops.sort((a, b) => a.distance - b.distance).slice(0, 5);
    } catch (error) {
      console.error("Find nearby stops error:", error);
      return [];
    }
  }

  // Helper method to calculate speed and bearing
  static calculateSpeedAndBearing(locations) {
    if (!locations || locations.length < 2) {
      return { speed: 0, bearing: null };
    }

    const recent = locations.slice(-2);
    const [prev, curr] = recent;

    if (!prev.coords || !curr.coords) {
      return { speed: 0, bearing: null };
    }

    const distance = LiveTrackingController.calculateDistance(
      prev.coords.coordinates,
      curr.coords.coordinates
    );

    const timeDiff = (new Date(curr.ts) - new Date(prev.ts)) / 1000; // seconds
    const speed = timeDiff > 0 ? (distance / timeDiff) * 3.6 : 0; // km/h

    const bearing = LiveTrackingController.calculateBearing(
      prev.coords.coordinates,
      curr.coords.coordinates
    );

    return {
      speed: Math.round(speed * 10) / 10,
      bearing: Math.round(bearing)
    };
  }

  // Utility methods
  static calculateDistance([lng1, lat1], [lng2, lat2]) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  static calculateBearing([lng1, lat1], [lng2, lat2]) {
    const dLon = (lng2 - lng1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    
    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
              Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
  }

  static pointToSegmentDistance([px, py], [ax, ay], [bx, by]) {
    const A = px - ax;
    const B = py - ay;
    const C = bx - ax;
    const D = by - ay;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    
    if (lenSq === 0) return this.calculateDistance([px, py], [ax, ay]);
    
    const param = dot / lenSq;
    let xx, yy;

    if (param < 0) {
      xx = ax;
      yy = ay;
    } else if (param > 1) {
      xx = bx;
      yy = by;
    } else {
      xx = ax + param * C;
      yy = ay + param * D;
    }

    return this.calculateDistance([px, py], [xx, yy]);
  }

  static calculateSegmentProgress([px, py], [ax, ay], [bx, by]) {
    const A = px - ax;
    const B = py - ay;
    const C = bx - ax;
    const D = by - ay;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    
    if (lenSq === 0) return 0;
    
    const param = Math.max(0, Math.min(1, dot / lenSq));
    return param * 100;
  }

  static calculateETA(trip, route, destinationStationId) {
    // Simplified ETA calculation
    // In a real implementation, this would consider traffic, historical data, etc.
    
    if (!trip.lastLocation || !route.stops) return null;

    const destStop = route.stops.find(
      stop => stop.station._id.toString() === destinationStationId.toString()
    );

    if (!destStop) return null;

    // Estimate based on average speed and remaining distance
    const avgSpeed = 25; // km/h average city bus speed
    const remainingDistance = destStop.distanceFromStart; // Simplified
    const etaMinutes = (remainingDistance / avgSpeed) * 60;

    const eta = new Date();
    eta.setMinutes(eta.getMinutes() + etaMinutes);

    return eta;
  }
}

module.exports = LiveTrackingController;