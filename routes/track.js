const express = require("express");
const router = express.Router();
const path = require("path");
const QRCode = require("../models/QRCode");
const geoip = require("geoip-lite");
const { recordScan, isQrCodeExpired } = require("../utils/analytics");

// Handle QR code scans
router.get("/:qrCodeId/:trackingId", async (req, res) => {
  console.log("Track route hit with params:", req.params);

  try {
    const { qrCodeId, trackingId } = req.params;
    console.log(
      "Processing scan for QR Code ID:",
      qrCodeId,
      "Tracking ID:",
      trackingId
    );

    const qrCode = await QRCode.findById(qrCodeId);
    console.log("Found QR Code:", qrCode ? "Yes" : "No");

    // Check if QR code exists
    if (!qrCode) {
      console.log("QR Code not found");
      return res.send(`
        <html>
          <head><title>QR Code Not Found</title></head>
          <body style="text-align:center;font-family:Arial;padding:20px;">
            <h2>⚠️ QR Code Not Found</h2>
            <p>This QR code does not exist or has been deleted.</p>
          </body>
        </html>
      `);
    }

    // Check for expiration
    const now = new Date();
    if (qrCode.security.expiresAt && now > qrCode.security.expiresAt) {
      console.log("QR Code expired");
      return res.send(`
        <html>
          <head><title>QR Code Expired</title></head>
          <body style="text-align:center;font-family:Arial;padding:20px;">
            <h2>⚠️ QR Code Expired</h2>
            <p>This QR code has expired and is no longer valid.</p>
          </body>
        </html>
      `);
    }

    // Check scan limit
    if (
      qrCode.security.maxScans > 0 &&
      qrCode.analytics.scanCount >= qrCode.security.maxScans
    ) {
      console.log("QR Code scan limit reached");
      return res.send(`
        <html>
          <head><title>Scan Limit Reached</title></head>
          <body style="text-align:center;font-family:Arial;padding:20px;">
            <h2>⚠️ Scan Limit Reached</h2>
            <p>This QR code has reached its maximum number of allowed scans.</p>
          </body>
        </html>
      `);
    }
    if (!qrCode) {
      console.log("QR Code not found");
      return res.status(404).send(`
        <html>
          <body style="text-align:center;font-family:Arial;padding:20px;">
            <h2>⚠️ QR Code Not Found</h2>
            <p>This QR code does not exist or has been deleted.</p>
          </body>
        </html>
      `);
    }

    // For password protected QR codes, show password form
    if (qrCode.security && qrCode.security.isPasswordProtected) {
      return res.send(`
        <html>
          <head>
            <title>Password Protected QR Code</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 20px; }
              .container { max-width: 400px; margin: 0 auto; }
              .form-group { margin-bottom: 15px; }
              input[type="password"] { 
                width: 100%; 
                padding: 8px; 
                margin: 8px 0;
                border: 1px solid #ddd;
                border-radius: 4px;
              }
              button {
                background-color: #007bff;
                color: white;
                padding: 10px 20px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
              }
              button:hover { background-color: #0056b3; }
              .error { color: red; margin-top: 10px; }
            </style>
          </head>
          <body>
            <div class="container">
              <h2>🔒 Password Protected QR Code</h2>
              <p>This QR code is password protected. Please enter the password to continue.</p>
              <form id="passwordForm" method="POST" action="/api/analytics/verify-password/${qrCode._id}">
                <input type="hidden" name="trackingId" value="${trackingId}">
                <div class="form-group">
                  <input type="password" name="password" placeholder="Enter password" required>
                </div>
                <button type="submit">Submit</button>
              </form>
              <div id="error" class="error" style="display: none;"></div>
            </div>
            <script>
              document.getElementById('passwordForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                
                try {
                  const formData = new FormData(e.target);
                  const response = await fetch(e.target.action, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      password: formData.get('password'),
                      trackingId: formData.get('trackingId')
                    })
                  });
                  
                  const data = await response.json();
                  
                  if (response.ok) {
                    if (data.expired) {
                      document.body.innerHTML = '<h2>⚠️ QR Code Expired</h2><p>' + data.message + '</p>';
                    } else {
                      window.location.href = data.redirectUrl || data.qrCode.text;
                    }
                  } else {
                    const error = document.getElementById('error');
                    error.textContent = data.error || 'Invalid password';
                    error.style.display = 'block';
                  }
                } catch (err) {
                  console.error('Error:', err);
                  const error = document.getElementById('error');
                  error.textContent = 'An error occurred. Please try again.';
                  error.style.display = 'block';
                }
              });
            </script>
          </body>
        </html>
      `);
    }

    // Check expiration first
    if (isQrCodeExpired(qrCode)) {
      console.log("QR Code expired");
      return res.send(`
        <html>
          <body style="text-align:center;font-family:Arial;padding:20px;">
            <h2>⚠️ QR Code Expired</h2>
            <p>This QR code has expired or reached its maximum scan limit.</p>
          </body>
        </html>
      `);
    } // Direct password protected QR codes to the verify page
    if (qrCode.security && qrCode.security.isPasswordProtected) {
      console.log("QR Code is password protected, redirecting to verify page");
      return res.sendFile(
        path.join(__dirname, "../public/password-verify.html")
      );
    }

    // Get IP and location info
    let ip = req.ip || req.connection.remoteAddress;
    // Remove IPv6 prefix if present
    ip = ip.replace(/^::ffff:/, "");

    console.log("Client IP:", ip);

    // Get location data from IP
    const geo = geoip.lookup(ip);
    console.log("Geolocation data:", geo);

    const locationData = {
      country: geo ? geo.country : "Unknown",
      city: geo ? geo.city : "Unknown",
    };

    console.log("Location data:", locationData);

    // If not password protected, record scan and redirect
    console.log("Recording scan for non-password protected QR code");

    try {
      const scanData = {
        userAgent: req.headers["user-agent"],
        ip: ip,
        referer: req.headers.referer,
        trackingId,
        country: locationData.country,
        city: locationData.city,
      };

      console.log("Scan data:", scanData);

      const updatedQrCode = await recordScan(qrCodeId, scanData);

      if (!updatedQrCode) {
        console.log("Failed to record scan - recordScan returned null");
        // Continue with redirect even if scan recording fails
      } else {
        console.log(
          "Scan recorded successfully. New scan count:",
          updatedQrCode.analytics.scanCount
        );
      }
    } catch (scanError) {
      console.error("Error recording scan:", scanError);
      // Continue with redirect even if scan recording fails
    }

    // Redirect to destination URL
    console.log("Redirecting to:", qrCode.text);
    res.redirect(qrCode.text);
  } catch (error) {
    console.error("Error handling QR scan:", error);
    res.status(500).send(`
      <html>
        <body style="text-align:center;font-family:Arial;padding:20px;">
          <h2>⚠️ Error</h2>
          <p>An error occurred while processing this QR code. Please try again later.</p>
        </body>
      </html>
    `);
  }
});

module.exports = router;
