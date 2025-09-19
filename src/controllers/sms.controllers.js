// Individual command controllers
import User from "../models/user.model.js";
import { encryptMessage } from '../utils/encryptMessage.js';
import { decryptMessage } from '../utils/decryptMessage.js';
import { ApiError } from '../utils/ApiError.js';
import twilio from "twilio";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Centralized response function to maintain consistency
const sendSmsResponse = async (phone, message) => {
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+91${phone}`,
    });
    return true;
  } catch (error) {
    console.error("SMS sending error:", error);
    return false;
  }
};

// Utility to safely extract phone number in consistent format
const extractPhone = (phoneString) => {
  if (!phoneString) return null;
  // Remove any '+' prefix and non-numeric characters
  return phoneString.toString().replace(/^\+/, "").replace(/\D/g, "");
};

// Generate tokens with proper error handling
const generateAccessToken = async (userId) => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new ApiError(404, "User not found");
    }
    
    const accessToken = await user.generateAccessToken();
    await user.save({ validateBeforeSave: false });
    return accessToken;
  } catch (error) {
    throw new ApiError(
      500,
      error.message || "Error generating access token"
    );
  }
};

// Verify token and get user
const verifyToken = async (token) => {
  try {
    if (!token) return null;
    
    // Implementation depends on your token verification logic
    // This is a placeholder for the actual verification
    const userId = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET)._id;
    const user = await User.findById(userId);
    return user;
  } catch (error) {
    return null;
  }
};

const smsControllers = {
  // Login controller
  loginController: async (req, res) => {
    try {
      const messageString = req.data?.trim() || "";
      const parts = messageString.split(" ");
      console.log(parts);
      
      // Extract phone from the message - expected format: "LOGIN <phone> <password>"
      const from = extractPhone(req.body?.From || parts[1]);
      
      if (!from || parts.length < 3) {
        await sendSmsResponse(
          from || req.body?.From,
          "Invalid format. Please send: LOGIN <password>"
        );
        return res.status(200).send();
      }

      const password = parts[2]?.trim();
      console.log(password);
      
      // Find user and verify credentials
      const user = await User.findOne({ phone: from });
      if (!user) {
        await sendSmsResponse(
          from,
          "Phone number not registered. Please register first."
        );
        return res.status(200).send();
      }

      const isPasswordValid = await user.isPasswordCorrect(password);
      if (!isPasswordValid) {
        await sendSmsResponse(from, "Invalid password. Please try again.");
        return res.status(200).send();
      }

      // Generate OTP with proper length and security
      const otp = Math.floor(100000 + Math.random() * 900000);
      user.otp = otp;
      user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      await user.save();

      await sendSmsResponse(
        from,
        `Your login OTP is: ${otp}. Reply with "VERIFY ${otp}" to complete login.`
      );

      return res.status(200).send();
    } catch (error) {
      console.error("Login controller error:", error);
      return res.status(200).send();
    }
  },

  // OTP verification controller
  otpController: async (req, res) => {
    try {
      const messageBody = req.data?.trim() || "";
      const parts = messageBody.split(" ");
      
      // Extract phone and OTP - expected format: "VERIFY <otp>"
      const from = extractPhone(req.body?.From);
      
      if (!from || parts.length < 2) {
        await sendSmsResponse(
          from || req.body?.From,
          "Invalid format. Please send: VERIFY <yourOTP>"
        );
        return res.status(200).send();
      }
      
      const otp = parseInt(parts[1]?.trim(), 10);
      if (isNaN(otp)) {
        await sendSmsResponse(from, "Invalid OTP format. Please try again.");
        return res.status(200).send();
      }

      // Find user and verify OTP
      const user = await User.findOne({ phone: from });
      if (!user) {
        await sendSmsResponse(
          from,
          "Phone number not registered. Please register first."
        );
        return res.status(200).send();
      }

      if (
        user.otp !== otp ||
        !user.otpExpiry ||
        user.otpExpiry < new Date()
      ) {
        await sendSmsResponse(
          from,
          "Invalid or expired OTP. Please request a new one."
        );
        return res.status(200).send();
      }

      // Clear OTP and generate token
      user.otp = undefined;
      user.otpExpiry = undefined;

      const accessToken = await generateAccessToken(user._id);
      await user.save();

      // Only encrypt sensitive information
      const encryptedMessage = await encryptMessage(
        `AUTH ${accessToken} BALANCE ${user.walletBalance.toFixed(2)}`
      );

      await sendSmsResponse(from, encryptedMessage);
      return res.status(200).send();
    } catch (error) {
      console.error("OTP controller error:", error);
      return res.status(200).send();
    }
  },


  



  // // Balance check controller
  // balanceController: async (req, res) => {
  //   try {
  //     const messageBody = req.data?.trim() || "";
  //     const parts = messageBody.split(" ");
  //     const from = extractPhone(req.body?.From);
  //     const token = parts.length > 1 ? parts[1]?.trim() : null;
  //     if (!from) {
  //       return res.status(200).send();
  //     }
  //     // Verify user's token if provided
  //     const user = token ? await verifyToken(token) : await User.findOne({ phone: from });
  //     if (!user) {
  //       await sendSmsResponse(
  //         from,
  //         "Phone number not found or authentication failed. Please register or login first."
  //       );
  //       return res.status(200).send();
  //     }
  //     await sendSmsResponse(
  //       from,
  //       `Your current wallet balance is: ${user.walletBalance.toFixed(2)}. UPI ID: ${user.upiId || "Not set"}`
  //     );
  //     return res.status(200).send();
  //   } catch (error) {
  //     console.error("Balance controller error:", error);
  //     return res.status(200).send();
  //   }
  // },

  // Transfer controller (for UPI transfers)
  transferController: async (req, res) => {
    try {
      const messageBody = req.data?.trim() || "";
      const parts = messageBody.split(" ");
      
      // Extract authentication token - expected format: "TRANSFER <amount> <upiId> <description> <token>"
      const from = extractPhone(req.body?.From);
      
      if (!from || parts.length < 4) {
        await sendSmsResponse(
          from || req.body?.From,
          "Invalid transfer format. Please send: TRANSFER <amount> <upiId> <description> <token>"
        );
        return res.status(200).send();
      }

      const amount = parseFloat(parts[1]?.trim());
      const recipientUPI = parts[2]?.trim();
      const description = parts[3]?.trim() || "UPI Transfer";
      const token = parts.length > 4 ? parts[4]?.trim() : null;
      
      if (isNaN(amount) || amount <= 0) {
        await sendSmsResponse(
          from,
          "Invalid amount. Please specify a positive number."
        );
        return res.status(200).send();
      }

      // Verify sender's token
      const sender = token ? await verifyToken(token) : await User.findOne({ phone: from });
      
      if (!sender) {
        await sendSmsResponse(
          from,
          "Authentication failed. Please login again."
        );
        return res.status(200).send();
      }

      // Check if sender has enough balance
      if (sender.walletBalance < amount) {
        await sendSmsResponse(
          from,
          `Insufficient balance. Your current balance is ${sender.walletBalance.toFixed(2)}`
        );
        return res.status(200).send();
      }

      // Find recipient by UPI ID
      const recipient = await User.findOne({ upiId: recipientUPI });
      if (!recipient) {
        await sendSmsResponse(
          from,
          "Recipient UPI ID not found. Please check the UPI ID."
        );
        return res.status(200).send();
      }

      // Process transfer with transaction
      // In production, use a database transaction here
      sender.walletBalance -= amount;
      recipient.walletBalance += amount;

      // Save transaction record
      const transaction = new Transaction({
        sender: sender._id,
        recipient: recipient._id,
        amount,
        description,
        type: "UPI_TRANSFER",
        timestamp: new Date()
      });

      await Promise.all([sender.save(), recipient.save(), transaction.save()]);

      // Notify sender
      await sendSmsResponse(
        from,
        `UPI transfer of ${amount.toFixed(2)} sent to ${recipient.name} (${recipientUPI}). Your new balance: ${sender.walletBalance.toFixed(2)}`
      );

      // Notify recipient
      await sendSmsResponse(
        recipient.phone,
        `You received ${amount.toFixed(2)} via UPI from ${sender.name} (${from}). Your new balance: ${recipient.walletBalance.toFixed(2)}`
      );

      return res.status(200).send();
    } catch (error) {
      console.error("Transfer controller error:", error);
      return res.status(200).send();
    }
  },

  // Help controller
  helpController: async (req, res) => {
    try {
      const from = extractPhone(req.body?.From);
      
      if (!from) {
        return res.status(200).send();
      }

      await sendSmsResponse(
        from,
        `Available commands:
- LOGIN <password>: Start login process
- VERIFY <otp>: Verify login OTP
- PAY <amount> <phone> <description>: Make payment
- BALANCE: Check wallet balance
- TRANSFER <amount> <upiId> <description>: UPI transfer
- HELP: Show this help menu`
      );

      return res.status(200).send();
    } catch (error) {
      console.error("Help controller error:", error);
      return res.status(200).send();
    }
  },
};

export { smsControllers };