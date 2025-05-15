/**
 * Routes for QR code generation and management
 */

const express = require("express");
const router = express.Router();
const QRCodeModel = require("../models/QRCode");
const QRCode = require("qrcode");
const authMiddleware = require("../middleware/auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs-extra");
const Jimp = require("jimp"); // Changed from require("jimp").default
const mongoose = require("mongoose");
const qrTypeFormatter = require("../utils/qrTypeFormatter");
const { createTrackingUrl } = require("../utils/analytics");

// Configure file upload for logos
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, "../uploads/logos");
    fs.ensureDirSync(uploadDir); // Create directory if it doesn't exist
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, "logo-" + uniqueSuffix + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 2 }, // 2MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|svg/;
    const ext = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mime = allowedTypes.test(file.mimetype);

    if (ext && mime) {
      return cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, and SVG files are allowed"));
    }
  },
});

// Get all QR codes for a user
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const qrCodes = await QRCodeModel.find({ userId }).sort({ createdAt: -1 });
    res.json(qrCodes);
  } catch (error) {
    console.error("Error getting QR codes:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get a specific QR code
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const qrCode = await QRCodeModel.findOne({ _id: id, userId });

    if (!qrCode) {
      return res
        .status(404)
        .json({ error: "QR code not found or unauthorized" });
    }

    res.json(qrCode);
  } catch (error) {
    console.error("Error getting QR code:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create a new QR code
router.post("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      text, // This is the original destination URL
      qrType = "url",
      customization = {},
      security = {}, // security object from request
      tags = [],
      enableTracking = true, // Default to true if not provided
    } = req.body;

    console.log(
      "Received request to create QR code. Security input:",
      JSON.stringify(security, null, 2)
    );

    // Validate and process security options
    const isProtected = Boolean(security.isPasswordProtected);
    let passwordValue = "";

    if (isProtected) {
      if (
        !security.password ||
        typeof security.password !== "string" ||
        security.password.trim() === ""
      ) {
        console.error(
          "Password validation failed during QR creation. Received security object:",
          JSON.stringify(security, null, 2)
        );
        return res.status(400).json({
          error:
            "Password is required and cannot be empty when password protection is enabled.",
        });
      }
      passwordValue = security.password.trim(); // Use trimmed password
      console.log(
        "Password protection enabled. Password to be saved (trimmed):",
        passwordValue
      );
    } else {
      console.log("Password protection not enabled.");
    }

    const processedSecurity = {
      isPasswordProtected: isProtected,
      password: passwordValue, // This will be empty if not protected, or the trimmed password if protected
      expiresAt: security.expiresAt ? new Date(security.expiresAt) : null, // Ensure Date object or null
      maxScans: parseInt(security.maxScans) || 0,
    };

    console.log(
      "Processed security object for new QR Code:",
      JSON.stringify(processedSecurity, null, 2)
    );

    let qrTextForImage = text;
    let finalTrackingUrl = null;
    const temporaryId = new mongoose.Types.ObjectId();
    if (enableTracking) {
      // Use RENDER_EXTERNAL_URL when in production, fallback to the request's origin
      const baseUrl =
        process.env.NODE_ENV === "production"
          ? "https://qr-generator-advanced.onrender.com"
          : `${req.protocol}://${req.get("host")}`;
      finalTrackingUrl = createTrackingUrl(baseUrl, temporaryId.toString());
      qrTextForImage = finalTrackingUrl;
    }

    const finalQrImage = await generateQRCodeWithLogo(
      qrTextForImage,
      customization
    );

    const qrCode = new QRCodeModel({
      _id: temporaryId,
      userId,
      text,
      qrImage: finalQrImage,
      qrType,
      security: processedSecurity,
      customization,
      tags,
      trackingEnabled: enableTracking,
      trackingUrl: finalTrackingUrl,
    });

    console.log(
      "QRCode Mongoose model instance before save. Security:",
      JSON.stringify(qrCode.toObject().security, null, 2)
    );

    await qrCode.save();

    console.log(
      "QRCode saved successfully. Security from saved document:",
      JSON.stringify(qrCode.toObject().security, null, 2)
    );

    res.status(201).json(qrCode);
  } catch (error) {
    console.error("Error creating QR code:", error.message);
    if (error.errors) {
      console.error(
        "Mongoose validation errors during creation:",
        JSON.stringify(error.errors, null, 2)
      );
    }
    console.error("Full error stack:", error.stack);
    res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
});

// Upload logo for QR code
router.post(
  "/upload-logo",
  authMiddleware,
  upload.single("logo"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No logo file uploaded" });
      }

      // Return the path to the uploaded logo
      const logoPath = `/uploads/logos/${req.file.filename}`;
      res.json({ logoPath });
    } catch (error) {
      console.error("Error uploading logo:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Format content based on QR type
router.post("/format-content", authMiddleware, async (req, res) => {
  try {
    const { qrType, data } = req.body;

    let formattedContent = "";

    switch (qrType) {
      case "vcard":
        formattedContent = qrTypeFormatter.formatVCard(data);
        break;
      case "wifi":
        formattedContent = qrTypeFormatter.formatWifi(data);
        break;
      case "email":
        formattedContent = qrTypeFormatter.formatEmail(data);
        break;
      case "sms":
        formattedContent = qrTypeFormatter.formatSMS(data);
        break;
      case "geo":
        formattedContent = qrTypeFormatter.formatGeo(data);
        break;
      case "event":
        formattedContent = qrTypeFormatter.formatEvent(data);
        break;
      default:
        formattedContent = data.text || "";
    }

    res.json({ formattedContent });
  } catch (error) {
    console.error("Error formatting content:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update a QR code
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const updateData = req.body;

    // Prevent updating userId
    delete updateData.userId;

    const qrCode = await QRCodeModel.findOneAndUpdate(
      { _id: id, userId },
      updateData,
      { new: true }
    );

    if (!qrCode) {
      return res
        .status(404)
        .json({ error: "QR code not found or unauthorized" });
    }

    res.json(qrCode);
  } catch (error) {
    console.error("Error updating QR code:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete a QR code
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const qrCode = await QRCodeModel.findOneAndDelete({ _id: id, userId });

    if (!qrCode) {
      return res
        .status(404)
        .json({ error: "QR code not found or unauthorized" });
    }

    res.json({ message: "QR code deleted successfully" });
  } catch (error) {
    console.error("Error deleting QR code:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Bulk delete QR codes
router.post("/delete-bulk", authMiddleware, async (req, res) => {
  try {
    const { qrCodeIds } = req.body;
    const userId = req.user.userId;

    if (!Array.isArray(qrCodeIds) || qrCodeIds.length === 0) {
      return res
        .status(400)
        .json({ error: "No QR codes specified for deletion" });
    }

    // Find and delete QR codes that belong to the user
    const result = await QRCodeModel.deleteMany({
      _id: { $in: qrCodeIds },
      userId: userId,
    });

    console.log("Bulk delete result:", result);

    res.json({
      message: `Successfully deleted ${result.deletedCount} QR codes`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error bulk deleting QR codes:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper function to calculate optimal QR version
function calculateOptimalVersion(contentLength, hasLogo) {
  let version = 2;
  while (version <= 40) {
    const effectiveLength = hasLogo
      ? Math.ceil(contentLength * 1.3)
      : contentLength;
    if (version * version * 4 >= effectiveLength) {
      return version;
    }
    version++;
  }
  return 40;
}

// Helper function to generate QR code with logo
async function generateQRCodeWithLogo(qrText, customization) {
  try {
    // console.log(`[generateQRCodeWithLogo] Called with qrText: '${qrText}', customization:`, JSON.stringify(customization)); // Optional: Log inputs

    const qrCodeBuffer = await QRCode.toBuffer(qrText, {
      errorCorrectionLevel: "H",
      margin: customization?.margin || 4,
      color: {
        dark: customization?.color || "#000000",
        light: customization?.backgroundColor || "#FFFFFF",
      },
      width: 1024, // Increased width for better logo clarity
    });

    const qrImage = await Jimp.read(qrCodeBuffer);

    if (
      customization?.logo &&
      typeof customization.logo === "string" &&
      customization.logo.trim() !== ""
    ) {
      let logoImage;
      if (
        customization.logo.startsWith("data:image") &&
        customization.logo.includes(";base64,")
      ) {
        // Handle base64 encoded logo
        // console.log("[generateQRCodeWithLogo] Processing base64 logo.");
        const base64Data = customization.logo.split(";base64,").pop();
        const logoBuffer = Buffer.from(base64Data, "base64");
        logoImage = await Jimp.read(logoBuffer);
      } else {
        // Handle logo as a file path (existing logic, as a fallback)
        // console.log("[generateQRCodeWithLogo] Processing logo as file path.");
        const logoFilename = path.basename(customization.logo);
        const logoDir = path.resolve(__dirname, "..", "uploads", "logos");
        const logoPath = path.join(logoDir, logoFilename);

        // console.log(`[generateQRCodeWithLogo] Attempting to read logo from: ${logoPath}`);

        if (!fs.existsSync(logoPath)) {
          console.error(
            `[generateQRCodeWithLogo] Logo file not found at: ${logoPath}. Original logo value: ${customization.logo}`
          );
          throw new Error(`Logo file not found. Attempted path: ${logoPath}`);
        }
        logoImage = await Jimp.read(logoPath);
      }

      const logoSize = qrImage.getWidth() * 0.25; // Logo size 25% of QR width
      logoImage.resize(logoSize, Jimp.AUTO); // Resize maintaining aspect ratio

      const xPos = (qrImage.getWidth() - logoImage.getWidth()) / 2;
      const yPos = (qrImage.getHeight() - logoImage.getHeight()) / 2;

      qrImage.composite(logoImage, xPos, yPos, {
        mode: Jimp.BLEND_SOURCE_OVER,
        opacitySource: 1,
        opacityDest: 1,
      });
    } else if (customization?.logo) {
      // console.log(`[generateQRCodeWithLogo] Invalid or empty logo path/data provided: ${customization.logo}`);
    }

    const mimeType = Jimp.MIME_PNG;
    const base64 = await qrImage.getBase64Async(mimeType);
    return base64;
  } catch (error) {
    console.error(
      "[generateQRCodeWithLogo] Error during processing. QR Text:",
      qrText,
      "Customization:",
      JSON.stringify(customization, null, 2), // Added null, 2 for pretty print
      "Error Message:",
      error.message,
      "Error Stack:",
      error.stack
    );
    throw new Error(
      `Failed during QR code generation with logo: ${error.message}`
    );
  }
}

// Bulk operations - create multiple QR codes
router.post("/bulk", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    // Destructure enableTracking from req.body, defaulting to true
    const { qrCodes, enableTracking = true } = req.body;

    if (!Array.isArray(qrCodes) || qrCodes.length === 0) {
      return res.status(400).json({ error: "No QR codes provided" });
    }
    const processedQRCodes = await Promise.all(
      qrCodes.map(async (qr) => {
        try {
          const temporaryId = new mongoose.Types.ObjectId();
          let qrTextForImage = qr.text; // Default to original text for QR image
          let finalTrackingUrl = null;
          if (enableTracking) {
            // Use RENDER_EXTERNAL_URL when in production, fallback to the request's origin
            const baseUrl =
              process.env.NODE_ENV === "production"
                ? "https://qr-generator-advanced.onrender.com"
                : `${req.protocol}://${req.get("host")}`;
            finalTrackingUrl = createTrackingUrl(
              baseUrl,
              temporaryId.toString()
            );
            qrTextForImage = finalTrackingUrl; // If tracking is on, QR image uses the tracking URL
          }

          const finalQrImage = await generateQRCodeWithLogo(
            qrTextForImage,
            qr.customization
          );

          const qrCode = new QRCodeModel({
            _id: temporaryId,
            userId,
            text: qr.text, // Original text
            qrImage: finalQrImage,
            qrType: qr.qrType || "url",
            security: {
              password: qr.security?.isPasswordProtected
                ? qr.security.password
                : "",
              isPasswordProtected: Boolean(qr.security?.isPasswordProtected),
              expiresAt: qr.security?.expiresAt || null,
              maxScans: parseInt(qr.security?.maxScans) || 0,
            },
            customization: qr.customization,
            tags: qr.tags || [],
            trackingEnabled: enableTracking, // Store tracking status
            trackingUrl: finalTrackingUrl, // Store the tracking URL if enabled
          });

          await qrCode.save();
          return qrCode;
        } catch (error) {
          console.error("Error processing QR code in bulk:", error);
          return null; // Return null for failed ones to filter out later
        }
      })
    );

    const successfulQRCodes = processedQRCodes.filter((qr) => qr !== null);

    res.status(201).json(successfulQRCodes);
  } catch (error) {
    console.error("Error in bulk QR code creation:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
