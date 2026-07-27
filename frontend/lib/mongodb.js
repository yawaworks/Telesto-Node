import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is not set in frontend/.env.local");
}

let client;
let clientPromise;

if (process.env.NODE_ENV === "development") {
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