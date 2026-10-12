// RideSync project 2, step 3
// Workflow 4: one pipeline, three facets computed off the same TripReviews match set --
// rating distribution, most frequent feedback tags (via $unwind), overall average rating.
//
// Depends on: docs/mongo_schema_map.json shape for TripReviews (rating, tags[], vehicle_id).
//
// (assignment 2) runs fleet-wide by default. it used to be scoped to a hardcoded
// vehicle_id that is not in the seeded data, so all three facets came back empty.
// set vehicleId to a real vehicles.id to scope it to one vehicle. the result is also
// printed now: mongosh does not echo expression values when it runs a script file.

const vehicleId = null; // e.g. "c3a91f2e-6b14-4d08-9e7a-21b0c84d5f33"

const reviewStats = db.TripReviews.aggregate([
    { $match: vehicleId ? { vehicle_id: vehicleId } : {} },
    {
        $facet: {
            rating_distribution: [
                { $group: { _id: "$rating", count: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ],
            top_feedback_tags: [
                { $unwind: "$tags" },
                { $group: { _id: "$tags", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 5 },
                { $project: { _id: 0, tag: "$_id", count: 1 } }
            ],
            overall_average_rating: [
                {
                    $group: {
                        _id: null,
                        average_rating: { $avg: "$rating" },
                        review_count: { $sum: 1 }
                    }
                },
                { $project: { _id: 0, average_rating: 1, review_count: 1 } }
            ]
        }
    }
]).toArray();

printjson(reviewStats);