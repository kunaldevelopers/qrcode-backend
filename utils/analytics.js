/**
 * Utility functions for tracking QR code scans and analytics
 */

const QRCode = require("../models/QRCode");
const shortid = require("shortid");

// Create a tracking URL for a QR code
const createTrackingUrl = (baseUrl, qrCodeId) => {
  const trackingId = shortid.generate();
  return `${baseUrl}/track/${qrCodeId}/${trackingId}`;
};

// Record a scan of a QR code
const recordScan = async (qrCodeId, scanData = {}) => {
  console.log(
    "[recordScan] Called with qrCodeId:",
    qrCodeId,
    "scanData:",
    scanData
  );
  try {
    const qrCode = await QRCode.findById(qrCodeId);
    console.log("[recordScan] QRCode found in DB:", qrCode);
    if (!qrCode) {
      console.log("[recordScan] QRCode not found, returning null.");
      return null;
    }

    // Check expiration before recording scan
    if (isQrCodeExpired(qrCode)) {
      console.log("[recordScan] QRCode is expired.");
      qrCode.isExpired = true;
      await qrCode.save();
      console.log(
        "[recordScan] QRCode marked as expired and saved, returning null."
      );
      return null;
    }

    // Process scan data
    const {
      userAgent = "",
      ip = "",
      referer = "",
      country = "Unknown",
      city = "Unknown",
    } = scanData;

    // Enhanced device detection
    let deviceType = "unknown";
    const ua = userAgent.toLowerCase();

    if (ua.includes("iphone") || ua.includes("ipad")) {
      deviceType = "ios";
    } else if (ua.includes("android")) {
      deviceType = "android";
    } else if (ua.includes("windows phone")) {
      deviceType = "windows phone";
    } else if (ua.includes("macintosh") || ua.includes("mac os")) {
      deviceType = "mac";
    } else if (ua.includes("windows")) {
      deviceType = "windows";
    } else if (ua.includes("linux")) {
      deviceType = "linux";
    }

    // Format for mobile/tablet detection
    if (deviceType === "unknown") {
      if (ua.includes("mobile") || ua.includes("tablet")) {
        deviceType = "mobile";
      } else if (
        ua.includes("windows") ||
        ua.includes("macintosh") ||
        ua.includes("linux")
      ) {
        deviceType = "desktop";
      }
    }

    // Get location data
    let locationInfo = {
      country: country || "Unknown",
      city: city || "Unknown",
    };

    // Use atomic update to increment scan count and update other fields
    const updatedQrCode = await QRCode.findByIdAndUpdate(
      qrCodeId,
      {
        $inc: { "analytics.scanCount": 1 },
        $set: {
          "analytics.lastScanned": new Date(),
          isExpired:
            qrCode.security.maxScans > 0 &&
            qrCode.analytics.scanCount + 1 >= qrCode.security.maxScans,
        },
        $push: {
          "analytics.scanLocations": {
            country: locationInfo.country,
            city: locationInfo.city,
            timestamp: new Date(),
          },
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    // Handle device analytics
    const deviceExists = await QRCode.findOne({
      _id: qrCodeId,
      "analytics.devices.type": deviceType,
    });

    if (deviceExists) {
      await QRCode.updateOne(
        {
          _id: qrCodeId,
          "analytics.devices.type": deviceType,
        },
        {
          $inc: { "analytics.devices.$.count": 1 },
        }
      );
    } else {
      await QRCode.updateOne(
        { _id: qrCodeId },
        {
          $push: {
            "analytics.devices": {
              type: deviceType,
              count: 1,
            },
          },
        }
      );
    }

    // Double-check the final state
    const finalQrCode = await QRCode.findById(qrCodeId);
    console.log("[recordScan] Final QR code state:", {
      scanCount: finalQrCode.analytics.scanCount,
      isExpired: finalQrCode.isExpired,
      devices: finalQrCode.analytics.devices,
      location: locationInfo,
    });

    return finalQrCode;
  } catch (error) {
    console.error("[recordScan] Error recording scan:", error);
    return null;
  }
};

// Check if a QR code has expired
const isQrCodeExpired = (qrCode) => {
  console.log("[isQrCodeExpired] Called with qrCode:", qrCode); // New log
  if (!qrCode) {
    console.log(
      "[isQrCodeExpired] No QRCode provided, returning true (expired)."
    ); // New log
    return true;
  }

  // Check if already marked as expired
  if (qrCode.isExpired) {
    console.log("[isQrCodeExpired] QRCode is already marked as expired."); // New log
    return true;
  }

  // Check expiration date
  if (qrCode.security.expiresAt) {
    const now = new Date();
    const expiry = new Date(qrCode.security.expiresAt);
    console.log(
      "[isQrCodeExpired] Checking expiration date - Now:",
      now,
      "Expiry:",
      expiry
    ); // New log
    if (!isNaN(expiry.getTime()) && now > expiry) {
      console.log("[isQrCodeExpired] QRCode has passed its expiration date."); // New log
      return true;
    }
  }

  // Check max scans
  if (
    qrCode.security.maxScans > 0 &&
    qrCode.analytics.scanCount >= qrCode.security.maxScans
  ) {
    console.log("[isQrCodeExpired] QRCode has reached max scans."); // New log
    return true;
  }

  console.log("[isQrCodeExpired] QRCode is not expired."); // New log
  return false;
};

// Get analytics for a QR code or user
const getAnalytics = async (qrCodeId = null, userId = null) => {
  console.log(
    "[getAnalytics] Called with qrCodeId:",
    qrCodeId,
    "userId:",
    userId
  ); // New log
  try {
    let query = {};

    if (qrCodeId) {
      query = { _id: qrCodeId };
    } else if (userId) {
      query = { userId };
    } else {
      return null;
    }

    const qrCodes = await QRCode.find(query);

    // For a single QR code
    if (qrCodeId) {
      return qrCodes[0]?.analytics || null;
    }

    // For all user's QR codes
    const analytics = {
      totalQrCodes: qrCodes.length,
      totalScans: 0,
      scansByDate: {},
      scansByDevice: {},
      scansByLocation: {},
      mostScanned: null,
    };

    let maxScans = 0;

    qrCodes.forEach((qr) => {
      // Count total scans
      analytics.totalScans += qr.analytics.scanCount || 0;

      // Find most scanned QR code
      if ((qr.analytics.scanCount || 0) > maxScans) {
        maxScans = qr.analytics.scanCount;
        analytics.mostScanned = {
          id: qr._id,
          text: qr.text,
          scanCount: qr.analytics.scanCount,
        };
      }

      // Count scans by device
      (qr.analytics.devices || []).forEach((device) => {
        if (!analytics.scansByDevice[device.type]) {
          analytics.scansByDevice[device.type] = 0;
        }
        analytics.scansByDevice[device.type] += device.count;
      });

      // Count scans by location
      (qr.analytics.scanLocations || []).forEach((location) => {
        const key = location.country || "Unknown";
        if (!analytics.scansByLocation[key]) {
          analytics.scansByLocation[key] = 0;
        }
        analytics.scansByLocation[key] += 1;
      });
    });

    return analytics;
  } catch (error) {
    console.error("Error getting analytics:", error);
    return null;
  }
};

module.exports = {
  createTrackingUrl,
  recordScan,
  isQrCodeExpired,
  getAnalytics,
};
