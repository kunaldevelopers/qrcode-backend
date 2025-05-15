const mongoose = require("mongoose");

const qrCodeSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
  },
  text: {
    type: String,
    required: true,
  },
  qrImage: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  qrType: {
    type: String,
    enum: [
      "url",
      "text",
      "vcard",
      "wifi",
      "email",
      "sms",
      "geo",
      "event",
      "phone",
    ],
    default: "url",
  },
  customization: {
    color: { type: String, default: "#000000" },
    backgroundColor: { type: String, default: "#ffffff" },
    logo: { type: String, default: null },
    margin: { type: Number, default: 4 },
  },
  analytics: {
    scanCount: { type: Number, default: 0 },
    lastScanned: { type: Date },
    scanLocations: [
      {
        country: String,
        city: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
    devices: [
      {
        type: String,
        count: Number,
      },
    ],
  },
  security: {
    password: {
      type: String,
    },
    isPasswordProtected: { type: Boolean, default: false },
    expiresAt: {
      type: Date,
      set: function (val) {
        // Convert string date to Date object and validate
        if (val) {
          const date = new Date(val);
          return isNaN(date.getTime()) ? null : date;
        }
        return null;
      },
    },
    maxScans: {
      type: Number,
      min: 0,
      set: function (val) {
        // Convert to integer and validate
        const num = parseInt(val);
        return isNaN(num) ? 0 : Math.max(0, num);
      },
    },
  },
  tags: [String],
  isExpired: { type: Boolean, default: false },
});

// Pre-save middleware to ensure consistent security state
qrCodeSchema.pre("save", function (next) {
  // Clear password if not password protected
  if (!this.security.isPasswordProtected) {
    this.security.password = "";
  }

  // Ensure maxScans is a positive number or 0
  if (
    typeof this.security.maxScans !== "number" ||
    this.security.maxScans < 0
  ) {
    this.security.maxScans = 0;
  }

  // Validate expiration date
  if (this.security.expiresAt) {
    const expiry = new Date(this.security.expiresAt);
    if (isNaN(expiry.getTime())) {
      this.security.expiresAt = null;
    }
  }

  next();
});

module.exports = mongoose.model("QRCode", qrCodeSchema);
