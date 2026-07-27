import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

let client;
let clientPromise;

if (!uri) {
  // Don't throw here — this module gets imported (and therefore executed)
  // during Next.js's build-time "Collecting page data" step for any route
  // that imports it, even ones that never actually run. A top-level throw
  // at that point kills the entire `next build`, not just this route.
  //
  // Instead, defer the failure to whenever a route actually awaits
  // clientPromise — it'll reject with a clear error at request time, and
  // the build itself can proceed as long as MONGODB_URI is set before
  // anyone actually hits /api/register (or any other Mongo-backed route).
  clientPromise = Promise.reject(
    new Error("MONGODB_URI is not set. Add it in Vercel's Environment Variables.")
  );
} else if (process.env.NODE_ENV === "development") {
  // Reuse the client across hot reloads in dev so we don't open a new
  // connection on every file change.
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri);
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  client = new MongoClient(uri);
  clientPromise = client.connect();
}

export default clientPromise;