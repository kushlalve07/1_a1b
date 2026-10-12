// RideSync project 2, step 3
// Workflow 3: find the closest available vehicle within 5km of a rider's location.
// "available" per README = TelemetryPings.is_available: true (not vehicles.is_active).
//
// Depends on: mongo/01_collections_and_indexes.js (2dsphere index on TelemetryPings.location)
// -- $geoNear requires that index to exist, and it must be the very first stage.
//
// coords are [lng, lat] (README convention). example point is inside the seed range
// from the README (lng 78.3-78.6, lat 17.3-17.5, Hyderabad) -- swap for a real rider location.

const riderLocation = { type: "Point", coordinates: [78.4867, 17.3850] };

// (assignment 2) the result is now printed. mongosh does not echo the value of an
// expression when it runs a script file, so this script used to print nothing.
const nearest = db.TelemetryPings.aggregate([
    {
        $geoNear: {
            near: riderLocation,
            distanceField: "distance_meters",
            maxDistance: 5000,          // 5km, per the pdf
            query: { is_available: true },
            spherical: true
        }
    },
    // if a vehicle has multiple recent pings, geoNear already returns closest-first,
    // but pin down "one row per vehicle, nearest ping wins" explicitly:
    { $sort: { distance_meters: 1 } },
    {
        $group: {
            _id: "$vehicle_id",
            distance_meters: { $first: "$distance_meters" },
            location: { $first: "$location" },
            created_at: { $first: "$created_at" }
        }
    },
    { $sort: { distance_meters: 1 } },
    { $limit: 1 },
    {
        $project: {
            _id: 0,
            vehicle_id: "$_id",
            distance_meters: 1,
            location: 1,
            created_at: 1
        }
    }
]).toArray();

printjson(nearest);