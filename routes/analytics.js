/**
 * Routes for QR code analytics and tracking
 */

const express = require("express");
const router = express.Router();
const QRCode = require("../models/QRCode");
const authMiddleware = require("../middleware/auth");
const {
  recordScan,
  getAnalytics,
  isQrCodeExpired,
} = require("../utils/analytics");

// Track QR code scan (no auth required)
router.get("/track/:qrCodeId/:trackingId", async (req, res) => {
  try {
    const { qrCodeId, trackingId } = req.params;

    // First check if QR code exists
    const qrCode = await QRCode.findById(qrCodeId);

    if (!qrCode) {
      return res.status(404).json({ error: "QR code not found" });
    }

    // Check security before recording scan
    if (isQrCodeExpired(qrCode)) {
      return res.json({
        expired: true,
        message: "This QR code has expired",
      });
    }

    // Record scan with available data
    const scanData = {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
      referer: req.headers.referer,
      country: "Unknown",
      city: "Unknown",
    };

    const updatedQrCode = await recordScan(qrCodeId, scanData);

    if (!updatedQrCode) {
      return res.json({
        expired: true,
        message: "This QR code has expired or reached maximum scans",
      });
    }

    if (updatedQrCode.security.isPasswordProtected) {
      return res.json({
        requiresPassword: true,
        qrCodeId,
        trackingId,
      });
    }

    res.json({
      success: true,
      qrCode: {
        text: updatedQrCode.text,
        type: updatedQrCode.qrType,
        analytics: {
          scanCount: updatedQrCode.analytics.scanCount,
          maxScans: updatedQrCode.security.maxScans || 0,
        },
      },
    });
  } catch (error) {
    console.error("Error tracking scan:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Verify password for password-protected QR code
router.post("/verify-password/:qrCodeId", async (req, res) => {
  try {
    const { qrCodeId } = req.params;
    const { password } = req.body;

    console.log(
      "Password verification attempt for QR:",
      qrCodeId,
      "Password received:",
      !!password
    );

    const qrCode = await QRCode.findById(qrCodeId);
    if (!qrCode) {
      console.log("QR code not found");
      return res.status(404).json({ error: "QR code not found" });
    }

    // Verify the QR code is actually password protected
    if (!qrCode.security?.isPasswordProtected) {
      console.log("QR code is not password protected");
      return res
        .status(400)
        .json({ error: "This QR code is not password protected" });
    }

    // Validate expiration
    if (
      qrCode.security.expiresAt &&
      new Date() > new Date(qrCode.security.expiresAt)
    ) {
      console.log("QR code expired");
      return res.status(410).json({
        expired: true,
        message: "This QR code has expired",
      });
    }

    // Validate scan limit
    if (
      qrCode.security.maxScans > 0 &&
      qrCode.analytics.scanCount >= qrCode.security.maxScans
    ) {
      console.log("Scan limit reached");
      return res.status(429).json({
        expired: true,
        message: "This QR code has reached its maximum number of scans",
      });
    }

    // Handle password check
    if (!password) {
      console.log("No password provided");
      return res.status(401).json({ error: "Password is required" });
    }

    // Compare passwords after trimming whitespace
    const storedPassword = qrCode.security.password.trim();
    const submittedPassword = password.trim();

    console.log("Comparing passwords (length):", {
      stored: storedPassword.length,
      provided: submittedPassword.length,
    });

    if (storedPassword !== submittedPassword) {
      console.log("Password mismatch");
      return res.status(401).json({
        error: "Invalid password",
        message: "The password you entered is incorrect. Please try again.",
      });
    }

    console.log("Password correct");

    // Record scan after successful password verification
    await recordScan(qrCodeId, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
      referer: req.headers.referer,
    });

    // Return success and the original destination URL
    res.json({
      success: true,
      redirectUrl: qrCode.text,
      message: "Password verified successfully",
      qrCode: {
        text: qrCode.text,
        type: qrCode.qrType,
        analytics: {
          scanCount: qrCode.analytics.scanCount,
          maxScans: qrCode.security.maxScans || 0,
        },
      },
    });
  } catch (error) {
    console.error("Error verifying password:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get analytics for all user's QR codes (requires auth)
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const analytics = await getAnalytics(null, userId);

    if (!analytics) {
      return res.status(404).json({ error: "No analytics found" });
    }

    res.json(analytics);
  } catch (error) {
    console.error("Error getting analytics:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get analytics for a specific QR code (requires auth)
router.get("/:qrCodeId", authMiddleware, async (req, res) => {
  try {
    const { qrCodeId } = req.params;
    const userId = req.user.userId;

    // First check if QR code belongs to the user
    const qrCode = await QRCode.findOne({ _id: qrCodeId, userId });

    if (!qrCode) {
      return res
        .status(404)
        .json({ error: "QR code not found or unauthorized" });
    }

    const analytics = await getAnalytics(qrCodeId);

    if (!analytics) {
      return res
        .status(404)
        .json({ error: "No analytics found for this QR code" });
    }

    res.json(analytics);
  } catch (error) {
    console.error("Error getting QR code analytics:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
