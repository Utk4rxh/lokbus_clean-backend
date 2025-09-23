const mongoose = require("mongoose");
async function connectDB(uri) {
  await mongoose.connect(uri);
  console.log("✅ MongoDB connection established");
}

module.exports = connectDB;
