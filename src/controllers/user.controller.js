// Import required dependencies
import User from "../models/user.model.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import twilio from "twilio";
import { encryptMessage } from "../utils/encryptMessage.js";
import { decryptMessage } from "../utils/decryptMessage.js";
import { asyncHandler } from "../../../Web/Backend/src/utils/asyncHandler.js";
import { ApiResponse } from "../../../Web/Backend/src/utils/ApiResponse.js";
import { ApiError } from "../../src/utils/ApiError.js";

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const generateAccessToken = async (userId) => {
  try {
    const user = await User.findById(userId);
    const accessToken = await user.generateAccessToken();

    await user.save({ validateBeforeSave: false });
    console.log(accessToken);
    
    return accessToken ;
  } catch (error) {
    throw new ApiError(
      500,
      error.message ||
        "Something went wrong while generating refresh and access token"
    );
  }
};
// App registration (requires internet)
const registerUser = asyncHandler(async (req, res) => {
  const {phone, name, upiId, password } = req.body;
  
  // Validate input
  if (!name.trim() || !phone.trim() || !upiId.trim() || !password.trim()) {
    return new ApiError(400,"All data is required");
  }

  // Check if user already exists
  const existingUser = await User.findOne({ $or: [{ phone }, { upiId }] });
  if (existingUser) {
    return res.status(409).json({
      success: false,
      message:
        existingUser.phone === phone
          ? "Phone number already registered"
          : "UPI ID already registered",
    });
  }

  const user = await User.create({
    name,
    phone,
    password,
    upiId,
  });
  const createdUser = await User.findById(user._id).select("-password");

  if (!createdUser)
    throw new ApiError(500, "Something went wrong while registering error");

  return res
    .status(201)
    .json(new ApiResponse(200, createdUser, "User registered successfully"));
});

const checkBalance = asyncHandler(async (req, res) => {
  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        req.user.walletBalance,
        "Balance fetched successfully"
      )
    );
});

async function checkBalanceViaSms(req, res) {
  try {
    const from = req.body.From;
    const formattedPhone = from.replace(/^\+/, "");

    // Find user by phone
    const user = await User.findOne({ phone: formattedPhone });
    if (!user) {
      await twilioClient.messages.create({
        body: "Phone number not found. Please register first.",
        from: process.env.TWILIO_PHONE_NUMBER,
        to: from,
      });
      return res.status(200).send();
    }

    // Send balance information
    await twilioClient.messages.create({
      body: `Your current wallet balance is: ${user.walletBalance}. UPI ID: ${user.upiId}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from,
    });

    return res.status(200).send();
  } catch (error) {
    console.error("Balance check error:", error);
    return res.status(200).send();
  }
}

// App-based login (for when users have internet)
async function appLogin(req, res) {
  try {
    const { phone, password } = req.body;
    // Validate input
    if (!phone || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Phone and password are required" });
    }

    // Find user by phone
    const user = await User.findOne({ phone });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000); // 6-digit OTP

    // Store OTP in user document with expiry time (10 minutes)
    user.otp = otp;
    user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    // Send OTP via Twilio SMS
    await twilioClient.messages.create({
      body: `Your login OTP is: ${otp}. Enter this in the app to complete your login.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+91${phone}`,
    });

    res.status(200).json({
      success: true,
      message: "OTP sent successfully",
      userId: user._id,
    });
  } catch (error) {
    console.error("App login error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// Verify OTP for app-based login
async function verifyAppOtp(req, res) {
  try {
    const { userId, otp } = req.body;

    // Validate input
    if (!userId || !otp) {
      return res
        .status(400)
        .json({ success: false, message: "User ID and OTP are required" });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    console.log(user.otp, parseInt(otp));
    
    // Verify OTP
    if (
      user.otp != parseInt(otp) ||
      !user.otpExpiry ||
      user.otpExpiry < new Date()
    ) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired OTP" });
    }

    // Clear OTP
    user.otp = undefined;
    user.otpExpiry = undefined;

    // Generate JWT
    const token = await generateAccessToken(user._id);
    console.log(token);
    
    await user.save();

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        upiId: user.upiId,
        walletBalance: user.walletBalance,
      },
    });
  } catch (error) {
    console.error("OTP verification error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// Auth middleware to check Bearer token

export { registerUser, appLogin, verifyAppOtp, checkBalance };
