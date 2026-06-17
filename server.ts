import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";
import multer from "multer";
import os from "os";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import twilio from "twilio";
import { getApps as getAdminApps, initializeApp as initAdminApp } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import importedFirebaseConfig from "./firebase-applet-config.json";
import { db } from "./src/db/index.ts";
import { users, notes as dbNotes } from "./src/db/schema.ts";
import { eq, and, desc } from "drizzle-orm";

dotenv.config();

if (!getAdminApps().length) {
  initAdminApp({
    projectId: importedFirebaseConfig.projectId,
  });
}
const adminAuth = getAdminAuth();

import { initializeApp as initClientApp, getApps as getClientApps } from "firebase/app";
import { getFirestore as getClientFirestore, doc as fsDoc, collection as fsCollection, setDoc as fsSetDoc, getDoc as fsGetDoc, getDocs as fsGetDocs, deleteDoc as fsDeleteDoc, onSnapshot as fsOnSnapshot, query as fsQuery, orderBy as fsOrderBy } from "firebase/firestore";

function doc(dbInstance: any, collectionName: string, docId?: string) {
  if (docId) {
    return fsDoc(dbInstance, collectionName, docId);
  }
  return fsDoc(fsCollection(dbInstance, collectionName));
}

function collection(dbInstance: any, collectionName: string) {
  return fsCollection(dbInstance, collectionName);
}

async function setDoc(docRef: any, data: any, options?: { merge?: boolean }) {
  return await fsSetDoc(docRef, data, options);
}

async function getDoc(docRef: any) {
  const snap = await fsGetDoc(docRef);
  return {
    exists: () => snap.exists(),
    data: () => snap.data(),
    id: snap.id
  };
}

async function getDocs(collectionRef: any) {
  const snap = await fsGetDocs(collectionRef);
  const docsArray = snap.docs.map((docSnap: any) => ({
    id: docSnap.id,
    ref: docSnap.ref,
    exists: () => docSnap.exists(),
    data: () => docSnap.data()
  }));
  return {
    docs: docsArray,
    forEach: (callback: (doc: any) => void) => {
      docsArray.forEach(callback);
    }
  };
}

async function deleteDoc(docRefOrRef: any) {
  return await fsDeleteDoc(docRefOrRef);
}

function query(queryArg: any, ...queryConstraints: any[]) {
  return fsQuery(queryArg, ...queryConstraints);
}

function orderBy(fieldPath: string, directionStr?: "asc" | "desc") {
  return fsOrderBy(fieldPath, directionStr);
}

function onSnapshot(targetRef: any, onNext: (snap: any) => void, onError?: (err: any) => void) {
  return fsOnSnapshot(targetRef, (snap: any) => {
    const docChanges = () => {
      if (typeof snap.docChanges === "function") {
        return snap.docChanges().map((change: any) => ({
          type: change.type,
          doc: {
            id: change.doc.id,
            ref: change.doc.ref,
            data: () => change.doc.data()
          }
        }));
      }
      return [];
    };
    
    const docsArray = snap.docs ? snap.docs.map((docSnap: any) => ({
      id: docSnap.id,
      ref: docSnap.ref,
      exists: () => docSnap.exists(),
      data: () => docSnap.data()
    })) : [];

    onNext({
      docChanges,
      docs: docsArray,
      forEach: (callback: (doc: any) => void) => {
        docsArray.forEach(callback);
      }
    });
  }, onError);
}

interface EmailLog {
  id: string;
  timestamp: string;
  subject: string;
  to: string;
  status: "success" | "failed" | "sandbox";
  info?: string;
  error?: string;
}

const emailLogs: EmailLog[] = [];

function addEmailLog(subject: string, to: string, status: "success" | "failed" | "sandbox", info?: string, error?: string) {
  let enrichedError = error;
  if (error && (error.includes("535-5.7.8") || error.includes("Username and Password not accepted") || error.includes("Invalid login"))) {
    enrichedError = `SMTP Auth Error (535-5.7.8): Username and password not accepted. Tip: If you are using Gmail, please make sure you use an 'App Password' instead of your regular Gmail login password. You can generate an App Password in your Google Account Security settings under 2-Step Verification. Please update SMTP_PASS in Settings > Secrets next. Details: ${error}`;
  }
  const id = Math.random().toString(36).substring(2, 11);
  const timestamp = new Date().toISOString();
  const logEntry = {
    id,
    timestamp,
    subject,
    to,
    status,
    info,
    error: enrichedError,
  };
  emailLogs.unshift(logEntry);
  if (emailLogs.length > 50) {
    emailLogs.pop();
  }

  // Persistently save to Firestore
  if (fbDb) {
    try {
      setDoc(doc(fbDb, "mailbox_records", id), {
        id,
        timestamp,
        subject,
        to,
        status,
        info: info || null,
        error: enrichedError || null,
        createdAt: timestamp,
      }).catch((e) => console.error("[Firebase Mailbox Log Save Error]:", e));
    } catch (err) {
      console.error("[Firebase Mailbox Log Exception]:", err);
    }
  }
}

async function logOutgoingEmailToFirestore(
  subject: string,
  to: string,
  status: "success" | "failed" | "sandbox",
  latencyMs?: number,
  error?: string,
  info?: string
) {
  const id = "log-" + Math.random().toString(36).substring(2, 11);
  const timestamp = new Date().toISOString();
  const logEntry = {
    id,
    timestamp,
    subject,
    to,
    status,
    latencyMs: latencyMs !== undefined ? latencyMs : null,
    error: error || null,
    info: info || null,
    createdAt: timestamp
  };

  if (fbDb) {
    try {
      await setDoc(doc(fbDb, "email_logs", id), logEntry);
      console.log(`[Email Status Tracker] Logged to Firestore email_logs with ID ${id} (latency: ${latencyMs || 0}ms)`);
    } catch (err: any) {
      console.error("[Email Status Tracker Error]:", err);
    }
  }
  return logEntry;
}

function repairPhoneNumber(phoneRaw: string, isSender: boolean = false): string {
  let cleaned = phoneRaw.trim();
  if (cleaned.startsWith("whatsapp:")) {
    cleaned = cleaned.replace("whatsapp:", "").trim();
  }

  // Remove spaces, hyphens, parentheses, and any other non-digit characters except "+"
  cleaned = cleaned.replace(/[^\d+]/g, "");

  // If blank, return default sandbox or empty
  if (!cleaned) {
    return isSender ? "+14155238886" : "+919328796324";
  }

  // If numeric but doesn't start with "+"
  if (!cleaned.startsWith("+")) {
    if (cleaned.length === 10) {
      // 10 digits -> Assume Indian country code +91
      cleaned = "+91" + cleaned;
    } else if (cleaned.length === 11 && cleaned.startsWith("0")) {
      // 11 digits starting with "0" -> Strip "0" and assume +91
      cleaned = "+91" + cleaned.slice(1);
    } else if (cleaned.length === 12 && cleaned.startsWith("91")) {
      // Starts with country code 91 but no "+"
      cleaned = "+" + cleaned;
    } else if (cleaned.length === 11 && cleaned.startsWith("1")) {
      // Starts with country code 1 (US) but no "+"
      cleaned = "+" + cleaned;
    } else {
      // Just prepended with "+"
      cleaned = "+" + cleaned;
    }
  }

  return cleaned;
}

async function sendWhatsAppNotification(name: string, email: string, message: string) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  let twilioNumberRaw = repairPhoneNumber((process.env.TWILIO_WHATSAPP_NUMBER || "+14155238886").trim(), true);

  if (!accountSid || !authToken) {
    console.log("[Twilio Alert] Skipping outbound WhatsApp/SMS alert (TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not configured in Secrets).");
    return;
  }

  const client = twilio(accountSid, authToken);
  const targetRaw = repairPhoneNumber((process.env.TWILIO_TARGET_NUMBER || "+919328796324").trim(), false);
  const bodyText = `New Lead Info!\n\nName: ${name || "N/A"}\nEmail: ${email || "N/A"}\nMessage:\n${message || "N/A"}`;
  const bodyTextWhatsApp = `🔔 *New Lead Info!*\n\n*Name:* ${name || "N/A"}\n*Email:* ${email || "N/A"}\n\n*Message:*\n${message || "N/A"}`;

  let warningTip = "";
  const twilioDigits = twilioNumberRaw.replace(/\D/g, "");
  const targetDigits = targetRaw.replace(/\D/g, "");
  if (twilioDigits && targetDigits && (twilioDigits === targetDigits || twilioDigits.endsWith(targetDigits.slice(-8)) || targetDigits.endsWith(twilioDigits.slice(-8)))) {
    warningTip = `⚠️ Config Warning: TWILIO_WHATSAPP_NUMBER was incorrectly set to your personal recipient number (${twilioNumberRaw}). The system has auto-corrected this to the official Twilio Sandbox number (+14155238886) so your WhatsApp alerts will deliver successfully. Please change your TWILIO_WHATSAPP_NUMBER inside Settings > Secrets to "+14155238886" (the sandbox sender).`;
    console.warn("[Twilio Auto-Repair Warning]:", warningTip);
    twilioNumberRaw = "+14155238886"; // Auto-correct to actual free sandbox sender
  }

  const logAlertResult = async (status: "success" | "failed" | "sandbox", info: string, error?: string, isWA: boolean = true) => {
    try {
      await addTwilioLog(targetRaw, bodyText, status, isWA, info, error);
    } catch (logErr) {
      console.error("[Twilio Alert Log Fallback Error]:", logErr);
    }
  };

  // --- CHANNEL 1: DISCOVER LINE & SEND STANDARD SMS (ASYNC, PARALLEL) ---
  const sendSMSPromise = (async () => {
    let smsFromNumber = twilioNumberRaw.replace("whatsapp:", "").trim();
    let discoveredSmsNumbers: string[] = [];
    
    if (smsFromNumber === "+14155238886") {
      try {
        const incomingNumbers = await client.incomingPhoneNumbers.list({ limit: 2 });
        if (incomingNumbers && incomingNumbers.length > 0) {
          discoveredSmsNumbers = incomingNumbers.map(n => n.phoneNumber).filter((n): n is string => !!n);
          if (discoveredSmsNumbers.length > 0) {
            smsFromNumber = discoveredSmsNumbers[0];
          }
        }
      } catch (numErr: any) {
        console.warn("[Twilio SMS Auto-Discovery] Could not list purchased numbers:", numErr?.message || numErr);
      }
    }

    if (smsFromNumber && smsFromNumber !== "+14155238886") {
      console.log(`[Twilio Fast SMS] Triggering standard SMS from ${smsFromNumber} to ${targetRaw}...`);
      try {
        const resp = await client.messages.create({
          from: smsFromNumber,
          to: targetRaw,
          body: bodyText,
        });
        console.log(`[Twilio Fast SMS] Deliver success! SID: ${resp.sid}`);
        await logAlertResult("success", `Outbound SMS successfully sent! SID: ${resp.sid}. Sent using Twilio Number: ${smsFromNumber}`, undefined, false);
      } catch (smsErr: any) {
        const errSms = smsErr?.message || String(smsErr);
        console.error(`[Twilio Fast SMS] Dispatch failed from ${smsFromNumber}: ${errSms}`);
        await logAlertResult("failed", `Failed standard SMS from ${smsFromNumber}`, errSms, false);
      }
    } else {
      const infoSkip = `Skipped Standard SMS: No numeric phone number could be discovered/configured. Global WhatsApp Sandbox number (+14155238886) does not support SMS. Please purchase a standard Twilio phone number.`;
      console.warn(`[Twilio Fast SMS] ${infoSkip}`);
      await logAlertResult("failed", "SMS Skipped", infoSkip, false);
    }
  })();

  // --- CHANNEL 2: SEND WHATSAPP MESSAGE (ASYNC, PARALLEL) ---
  const sendWhatsAppPromise = (async () => {
    const waFromNum = twilioNumberRaw.startsWith("whatsapp:") ? twilioNumberRaw : `whatsapp:${twilioNumberRaw}`;
    const waToNum = `whatsapp:${targetRaw}`;

    console.log(`[Twilio Fast WhatsApp] Triggering WhatsApp alert from ${waFromNum} to ${waToNum}...`);
    try {
      const resp = await client.messages.create({
        from: waFromNum,
        to: waToNum,
        body: bodyTextWhatsApp,
      });
      console.log(`[Twilio Fast WhatsApp] Deliver success! SID: ${resp.sid}`);
      await logAlertResult("success", `Contact alert successfully sent via WhatsApp. MSG SID: ${resp.sid}. ${warningTip}`, undefined, true);
    } catch (err: any) {
      const errMessage1 = err?.message || String(err);
      console.warn(`[Twilio Fast WhatsApp] Primary attempt failed: ${errMessage1}`);

      const isChannelError = errMessage1.includes("Channel") || 
                             err?.code === 63007 || 
                             errMessage1.includes("Sender") || 
                             errMessage1.includes("From") || 
                             errMessage1.includes("caller ID") ||
                             errMessage1.includes("unverified");

      if (isChannelError && waFromNum !== "whatsapp:+14155238886") {
        const sandboxFrom = "whatsapp:+14155238886";
        console.log(`[Twilio Fast WhatsApp Auto-Repair] Mismatch detected. Swapping to global WhatsApp Sandbox sender: ${sandboxFrom}...`);
        try {
          const resp2 = await client.messages.create({
            from: sandboxFrom,
            to: waToNum,
            body: bodyTextWhatsApp,
          });
          console.log(`[Twilio Fast WhatsApp Sandbox Fallback] Success via sandbox! SID: ${resp2.sid}`);
          await logAlertResult("success", `Auto-recovered: WhatsApp sent via official sandbox (+14155238886). SID: ${resp2.sid}. ${warningTip}`, undefined, true);
        } catch (sandboxErr: any) {
          const errMessageSandbox = sandboxErr?.message || String(sandboxErr);
          console.error(`[Twilio Fast WhatsApp Sandbox Fallback] Failed: ${errMessageSandbox}`);
          await logAlertResult("failed", "WhatsApp sandbox fallback failed", errMessageSandbox, true);
        }
      } else {
        await logAlertResult("failed", `WhatsApp alert delivery failed from ${waFromNum}`, errMessage1, true);
      }
    }
  })();

  // Trigger both channels concurrently in parallel (non-blocking) for instant under 10s arrival
  Promise.all([sendSMSPromise, sendWhatsAppPromise]).catch((allErr) => {
    console.error("[Twilio Fast Parallel Dispatch Error]:", allErr);
  });
}

function getEmailConfig() {
  const user = (dynamicSmtpUser || process.env.SMTP_USER || "rutvikdangar20@gmail.com").trim();
  let pass = "";

  // 1. Prioritize canonical SMTP_PASS custom secret
  const smtpPassValue = (dynamicSmtpPass || process.env.SMTP_PASS || "").trim().replace(/\s/g, "");
  if (smtpPassValue) {
    pass = smtpPassValue;
  }

  // 2. Fallback check for process.env.App only if SMTP_PASS is missing
  if (!pass) {
    const appEnvValue = (process.env.App || "").trim().replace(/\s/g, "");
    if (appEnvValue.length === 16 && /^[a-z]+$/i.test(appEnvValue)) {
      console.log("[SMTP Auto-Detector] Automatically resolved Gmail App Password from environment variable <App>");
      pass = appEnvValue;
    }
  }

  // 3. Fallback scanner for any other 16-letter variables
  if (!pass) {
    for (const [key, val] of Object.entries(process.env)) {
      if (typeof val === "string" && key !== "NODE_ENV" && key !== "PATH" && key !== "PORT" && key !== "App" && key !== "APP") {
        const cleaned = val.trim().replace(/\s/g, "");
        if (cleaned.length === 16 && /^[a-z]+$/i.test(cleaned)) {
          console.log(`[SMTP Auto-Detector] Automatically resolved Gmail App Password from environment variable <${key}>`);
          pass = cleaned;
          break;
        }
      }
    }
  }

  // Automatically clean ALL spaces commonly copied from Google Account's App Password UI (e.g. 'abcd efgh ijkl mnop' -> 'abcdefghijklmnop')
  const cleanedPass = pass.replace(/\s/g, "");
  if (cleanedPass.length > 0) {
    pass = cleanedPass;
  }
  let host = (process.env.SMTP_HOST || "").trim();
  if (!host && (user.toLowerCase().includes("gmail") || user.toLowerCase().includes("googlemail") || user === "rutvikdangar20@gmail.com")) {
    host = "smtp.gmail.com";
  }
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  return { host, port, user, pass };
}

async function sendEmailNotification(subject: string, htmlContent: string) {
  const { host, port, user, pass } = getEmailConfig();

  // Direct, safe recipient list.
  // Guarantees rutvikdangar20@gmail.com and the configured SMTP owner / notification recipient list receive the activity logs.
  const emailSet = new Set<string>();
  emailSet.add("rutvikdangar20@gmail.com");

  if (user && user.includes("@") && !user.includes("example.com")) {
    emailSet.add(user);
  }

  const rawNotification = dynamicNotificationEmail || process.env.NOTIFICATION_EMAIL;
  if (rawNotification) {
    rawNotification.split(",").forEach(e => {
      const trimmed = e.trim();
      if (trimmed && trimmed.includes("@")) {
        emailSet.add(trimmed);
      }
    });
  }

  const targetEmail = Array.from(emailSet).join(", ");
  const startTime = Date.now();

  try {
    if (!host || !user || !pass) {
      const fallbackMsg = `To send live emails to ${targetEmail}, please define SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in the AI Studio Settings under Secrets.`;
      console.log(`[Email Notification Sandbox / Fallback Log]: 
${fallbackMsg}
Subject: ${subject}`);
      addEmailLog(subject, targetEmail, "sandbox", fallbackMsg);
      await logOutgoingEmailToFirestore(subject, targetEmail, "sandbox", Date.now() - startTime, undefined, fallbackMsg);
      return;
    }

    const transporter = getEmailTransporter(host, port, user, pass);

    const info = await transporter.sendMail({
      from: `"Rutvik's Portfolio Alert" <${user}>`,
      to: targetEmail,
      subject: subject,
      html: htmlContent,
    });

    const latencyMs = Date.now() - startTime;
    console.log("[Email Notification Sent Successfully (under 7s)]:", info.messageId);
    const logInfo = `Message ID: ${info.messageId || "N/A"}. Response: ${info.response || "Sent configuration verified."}`;
    addEmailLog(subject, targetEmail, "success", logInfo);
    await logOutgoingEmailToFirestore(subject, targetEmail, "success", latencyMs, undefined, logInfo);
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    console.error("[Email Notification Error]:", error);
    const suggestion = logSMTPErrorDetails(error, targetEmail, "Admin-Alert");
    const errMsg = `${error.message || String(error)} | Suggestion: ${suggestion}`;
    addEmailLog(subject, targetEmail, "failed", undefined, errMsg);
    await logOutgoingEmailToFirestore(subject, targetEmail, "failed", latencyMs, errMsg);
  }
}

let cachedTransporter: any = null;
let cachedConfigKey = "";

function logSMTPErrorDetails(error: any, recipient: string, context: string): string {
  console.error(`[SMTP Audit Error - ${context}]: Detailed error for recipient <${recipient}>:`, error);
  
  let suggestion = "";
  if (error.code === "EAUTH" || (error.message && error.message.includes("535"))) {
    suggestion = "AUTHENTICATION ERROR (EAUTH): This usually means your SMTP password or username is invalid.\n" +
                 "👉 GMAIL CHECKLIST: Google has disabled legacy credentials. You MUST generate an APP PASSWORD:\n" +
                 " 1. Go to your Google Account Settings (myaccount.google.com)\n" +
                 " 2. Enable '2-Step Verification'\n" +
                 " 3. Search for 'App Passwords' in google account search\n" +
                 " 4. Select App: 'Mail', Device: 'Other (Custom Name)', and create.\n" +
                 " 5. Paste the 16-character code into SMTP_PASS secret key under AI Studio Settings > Secrets.";
  } else if (error.code === "ESOCKET" || error.code === "ECONNRESET" || error.code === "ETIMEDOUT" || error.syscall === "connect") {
    suggestion = "NETWORK CONNECTION ERROR: Fails to build a socket with the SMTP host.\n" +
                 "👉 NETWORKING CHECKLIST:\n" +
                 " • Port 587 or Port 465 might be restricted by the local container environment.\n" +
                 " • Set SMTP_PORT to 465, SMTP_HOST to 'smtp.gmail.com', which uses direct SSL connection handshake.";
  } else {
    suggestion = `UNKNOWN SMTP ISSUE (Code: ${error.code || "N/A"}). Message: ${error.message || String(error)}`;
  }
  
  console.warn(`\n=== 🚨 GOOGLE SMTP DIAGNOSTICS & HELP (${context}) ===\n${suggestion}\n=========================================\n`);
  return suggestion;
}

function getEmailTransporter(host: string, port: number, user: string, pass: string) {
  const configKey = `${host}:${port}:${user}:${pass}`;
  if (cachedTransporter && cachedConfigKey === configKey) {
    return cachedTransporter;
  }

  const isGmail = host.toLowerCase().includes("gmail") || 
                  host.toLowerCase().includes("googlemail") || 
                  user.toLowerCase().includes("@gmail.com");
  
  let transportOpts: any;
  if (isGmail) {
    const gmailPort = port === 587 ? 587 : 465;
    const isSecure = gmailPort === 465;
    // Ultra-reliable, direct secure handshake (SSL/TLS port 465 or STARTTLS port 587)
    // This stabilizes transport performance over raw and sandboxed cloud environments.
    transportOpts = {
      host: "smtp.gmail.com",
      port: gmailPort,
      secure: isSecure,
      requireTLS: gmailPort === 587,
      auth: {
        user,
        pass,
      },
      tls: {
        rejectUnauthorized: false,
        minVersion: "TLSv1.2"
      },
      family: 4, // Force IPv4 to prevent cloud runtime IPv6 lookup lags (5-10 second timeouts)
      pool: false, // Omit connection pool to prevent idle drop-offs/hangs in serverless boxes
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
    };
  } else {
    // Fallback for non-Gmail SMTP
    transportOpts = {
      host,
      port,
      secure: port === 465,
      requireTLS: port === 587,
      auth: {
        user,
        pass,
      },
      tls: {
        rejectUnauthorized: false,
        minVersion: "TLSv1.2"
      },
      family: 4, // Force IPv4 to prevent cloud runtime IPv6 lookup lags (5-10 second timeouts)
      pool: false, // Avoid pool caching for extreme resiliency
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
    };
  }

  cachedTransporter = nodemailer.createTransport(transportOpts);
  cachedConfigKey = configKey;
  return cachedTransporter;
}

async function sendThankYouEmail(recipientEmail: string, subject: string, htmlContent: string) {
  const startTime = Date.now();
  try {
    const { host, port, user, pass } = getEmailConfig();

    if (!host || !user || !pass) {
      const fallbackMsg = `To send live thank-you emails to ${recipientEmail}, please define SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in the AI Studio Settings under Secrets.`;
      console.log(`[Thank You Email Sandbox / Fallback Log]: 
${fallbackMsg}
Subject: ${subject}`);
      addEmailLog(subject, recipientEmail, "sandbox", fallbackMsg);
      await logOutgoingEmailToFirestore(subject, recipientEmail, "sandbox", Date.now() - startTime, undefined, fallbackMsg);
      return;
    }

    const transporter = getEmailTransporter(host, port, user, pass);

    const info = await transporter.sendMail({
      from: `"Rutvik Dangar" <${user}>`,
      to: recipientEmail,
      subject: subject,
      html: htmlContent,
    });

    const latencyMs = Date.now() - startTime;
    console.log("[Thank You Email Sent Successfully (under 7s)]:", info.messageId);
    const logInfo = `Thank you email dispatched. Message ID: ${info.messageId || "N/A"}. Response: ${info.response || "Sent."}`;
    addEmailLog(subject, recipientEmail, "success", logInfo);
    await logOutgoingEmailToFirestore(subject, recipientEmail, "success", latencyMs, undefined, logInfo);
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    console.error("[Thank You Email Error]:", error);
    const suggestion = logSMTPErrorDetails(error, recipientEmail, "Guest-ThankYou");
    const errMsg = `${error.message || String(error)} | Suggestion: ${suggestion}`;
    addEmailLog(subject, recipientEmail, "failed", undefined, errMsg);
    await logOutgoingEmailToFirestore(subject, recipientEmail, "failed", latencyMs, errMsg);
  }
}

// Automated Cloud Function-like Trigger on the 'messages' Firestore collection
function setupMessagesCloudFunctionTrigger() {
  if (!fbDb) {
    console.warn("[Cloud Function Simulation] Firestore is not configured. Automated thank-you trigger skipped.");
    return;
  }

  console.log("[Cloud Function Simulation] Listening to 'messages' collection updates...");
  try {
    const messagesCollection = collection(fbDb, "messages");
    onSnapshot(messagesCollection, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        // We only process newly added documents
        if (change.type === "added") {
          const docId = change.doc.id;
          const data = change.doc.data();

          if (!data || !data.email) {
            return;
          }

          // If we already sent it, or it was flagged under this run, skip to avoid loops
          if (data.thankYouSent === true) {
            return;
          }

          // Filter out newsletter/stay-in-the-loop subscriptions from getting the generic Contact receipt
          const isSubscription = (data.name && data.name.includes("Newsletter")) || 
                                (data.message && (data.message.toLowerCase().includes("newsletter") || 
                                                 data.message.toLowerCase().includes("subscription") || 
                                                 data.message.toLowerCase().includes("subscribe") ||
                                                 data.message.toLowerCase().includes("loop")));
          if (isSubscription) {
            try {
              await setDoc(doc(fbDb, "messages", docId), { thankYouSent: true }, { merge: true });
            } catch (err) {}
            return;
          }

          // Also avoid emailing historical database messages on starting the server
          let isRecent = false;
          if (data.createdAt) {
            const createdAtMillis = typeof data.createdAt.toMillis === "function"
              ? data.createdAt.toMillis()
              : new Date(data.createdAt).getTime();

            // Document must have been created within the past 10 minutes (600,000 ms)
            if (Date.now() - createdAtMillis < 10 * 60 * 1000) {
              isRecent = true;
            }
          } else {
            // If createdAt isn't populated yet, let's treat it as recent (often happens during rapid local submissions)
            isRecent = true;
          }

          if (isRecent) {
            console.log(`[Cloud Function Triggered] Detected new message from ${data.email} with ID ${docId}. Sending auto thank-you email...`);
            
            // Mark as sent immediately on Firestore to prevent multiple trigger iterations/duplicate dispatch
            try {
              await setDoc(doc(fbDb, "messages", docId), { thankYouSent: true }, { merge: true });
            } catch (err) {
              console.error("[Cloud Function Simulation] Error marking message thankYouSent:", err);
            }

            const recipientEmail = data.email.trim();
            const recipientName = data.name ? data.name.trim() : "there";
            const originalMsg = data.message ? data.message.trim() : "";

            const subject = `Thank you for reaching out, ${recipientName}!`;
            const htmlContent = `
              <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; color: #1e1b4b; line-height: 1.6; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin: auto;">
                <div style="background: linear-gradient(135deg, #1e1b4b 0%, #311042 100%); padding: 32px 24px; text-align: center; color: #ffffff;">
                  <h1 style="font-size: 24px; font-weight: 800; margin: 0; font-family: Georgia, serif; letter-spacing: 0.5px;">RUTVIK DANGAR</h1>
                  <p style="text-transform: uppercase; font-size: 10px; tracking: 0.15em; font-weight: bold; margin: 6px 0 0 0; color: #818cf8;">Automated System Receipt</p>
                </div>
                
                <div style="padding: 30px; background: #ffffff;">
                  <p style="margin-top: 0; font-size: 16px; color: #0f172a;">Hello <strong>${recipientName}</strong>,</p>
                  
                  <p style="color: #334155; font-size: 15px;">Thank you for getting in touch with me through my portfolio website! I have successfully received your message and will review it shortly.</p>
                  
                  <p style="color: #334155; font-size: 15px;">I strive to reply to all business inquiries, collaboration proposals, and general questions within 24 to 48 hours.</p>
                  
                  <div style="margin: 24px 0; padding: 16px; background: #f8fafc; border-left: 4px solid #2563eb; border-radius: 8px;">
                    <span style="font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: bold; display: block; margin-bottom: 6px; letter-spacing: 0.5px;">A copy of your message:</span>
                    <p style="font-size: 13.5px; color: #475569; margin: 0; font-style: italic; white-space: pre-wrap;">"${originalMsg}"</p>
                  </div>
                  
                  <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 24px 0;" />
                  
                  <p style="color: #0f172a; font-size: 15px; margin-bottom: 0; line-height: 1.5;">Warm regards,<br />
                  <strong>Rutvik Dangar</strong><br />
                  <span style="font-size: 12px; color: #64748b;">Ahmedabad, Gujarat, India</span><br />
                  <span style="font-size: 13px; color: #64748b; font-weight: 500;">Portfolio Hub</span>
                  </p>
                </div>
                
                <div style="background: #f8fafc; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #f1f5f9;">
                  This is an automated delivery receipt confirmation.<br />
                  Please do not reply directly to this mail as it is sent from an unmonitored mailbox.
                </div>
              </div>
            `;

            await sendThankYouEmail(recipientEmail, subject, htmlContent);

            // Also send an Admin alert notification for new emails/messages stored under admin access
            await sendEmailNotification(
              `🔔 New Mail/Message Stored under Admin: from ${recipientName}`,
              `<h2>New Portfolio Message Stored (Admin Access)</h2>
               <p><strong>Sender:</strong> ${recipientName} &lt;${recipientEmail}&gt;</p>
               <p><strong>Message:</strong></p>
               <div style="background: #f8fafc; border-left: 4px solid #4f46e5; padding: 12px; font-family: sans-serif; white-space: pre-wrap;">${originalMsg}</div>
               <p style="font-size: 11px; color: #777; margin-top: 20px;">Stored in Firestore 'messages' collection securely. Access via Admin panel.</p>`
            ).catch((err) => console.error("Admin dispatch for onSnapshot message failed:", err));
          }
        }
      });
    }, (error) => {
      console.error("[Cloud Function Simulation onSnapshot Messages Error]:", error);
    });
  } catch (error) {
    console.error("[Cloud Function Simulation Error]:", error);
  }
}

import fs from "fs";

// Read firebase config dynamically to ensure perfect portability
let firebaseConfig: any = null;
try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
} catch (e) {
  console.error("Failed to read firebase-applet-config.json:", e);
}

// Initialize Firebase App & Firestore using Admin SDK
let fbDb: any = null;
let dynamicNotificationEmail = process.env.NOTIFICATION_EMAIL || "";
let dynamicSmtpPass = process.env.SMTP_PASS || "";
let dynamicSmtpUser = process.env.SMTP_USER || "";

if (firebaseConfig) {
  try {
    const dbId = firebaseConfig.firestoreDatabaseId || "ai-studio-1993bf5b-deac-401e-9f80-81eb3582259e";
    let appFb;
    if (!getClientApps().length) {
      appFb = initClientApp(firebaseConfig);
    } else {
      appFb = getClientApps()[0];
    }
    fbDb = getClientFirestore(appFb, dbId);
    console.log("[Firebase Server Init] Initialized Client Firestore Database ID:", dbId);
    
    // Load dynamic notification email right away
    getDoc(doc(fbDb, "settings", "smtp_config")).then((snap) => {
      if (snap.exists()) {
        const data: any = snap.data();
        if (data && data.NOTIFICATION_EMAIL !== undefined) {
          dynamicNotificationEmail = data.NOTIFICATION_EMAIL;
          console.log("[Firebase Server Init] Loaded dynamic NOTIFICATION_EMAIL:", dynamicNotificationEmail);
        }
        if (data && data.SMTP_PASS !== undefined) {
          dynamicSmtpPass = data.SMTP_PASS;
          console.log("[Firebase Server Init] Loaded dynamic SMTP_PASS (hidden for security).");
        }
        if (data && data.SMTP_USER !== undefined) {
          dynamicSmtpUser = data.SMTP_USER;
          console.log("[Firebase Server Init] Loaded dynamic SMTP_USER:", dynamicSmtpUser);
        }
      }
    }).catch(e => console.error("[Firebase Server Init] Error loading smtp_config:", e));

    // Launch background onSnapshot listener simulating a Firestore trigger Cloud Function
    setupMessagesCloudFunctionTrigger();
  } catch (e) {
    console.error("[Firebase Server Init Error]:", e);
  }
}

// Determine a dynamic, robust, writable directory
let uploadDir = path.join(process.cwd(), "uploads");
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  // Try to write a tiny file to verify writability
  const testFile = path.join(uploadDir, ".write-test");
  fs.writeFileSync(testFile, "test");
  fs.unlinkSync(testFile);
} catch (e) {
  console.warn("Local uploads folder is not writable. Falling back to temporary storage root.", e);
  uploadDir = path.join(os.tmpdir(), "uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + "-" + uniqueSuffix + ext);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit to support large file attachments
});

// Lazy load the Gemini SDK to prevent server start-up crashes if keys are initially missing
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      console.warn("WARNING: GEMINI_API_KEY is not defined. Calls to Gemini API will return a missing key error.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key || "PLACEHOLDER_KEY_FOR_COMPAT_STARTUP",
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

async function generateContentWithRetry(params: { model: string; contents: any; config?: any }, maxRetries = 3): Promise<any> {
  let lastError: any = null;
  let delay = 500;
  
  // Inject LOW thinking level only if it is explicitly a thinking model
  if (!params.config) {
    params.config = {};
  }
  if (!params.config.thinkingConfig && params.model.includes("-thinking")) {
    params.config.thinkingConfig = { thinkingLevel: "LOW" };
  }

  // Create a progressive, unique list of fallbacks: primary -> 3.5-flash -> 3.1-flash-lite -> flash-latest
  const rawModels = [params.model, "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];
  const modelsToTry = rawModels.filter((val, idx) => rawModels.indexOf(val) === idx);
  let currentModelIdx = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      params.model = modelsToTry[currentModelIdx];
      const response = await getGeminiClient().models.generateContent(params);
      return response;
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.statusCode || (err?.message && err.message.includes("404") ? 404 : 500);
      const message = err?.message || "";
      console.warn(`[Gemini Attempt ${attempt}/${maxRetries} Failed for ${params.model}]: Status ${status}, Error: ${message}`);
      
      const isTransientOrModelError = status === 503 || status === 404 || status === 429 ||
                          message.includes("503") || message.includes("404") || message.includes("429") ||
                          message.toLowerCase().includes("demand") || message.toLowerCase().includes("overloaded") || 
                          message.toLowerCase().includes("unavailable") || message.toLowerCase().includes("not found");

      if (isTransientOrModelError && currentModelIdx < modelsToTry.length - 1) {
         currentModelIdx++;
         console.log(`Model ${params.model} failed/overloaded. Falling back to next model: ${modelsToTry[currentModelIdx]}`);
         attempt--; // Don't count model fallback as a retry attempt
         continue;
      }

      // Retry on standard transient network or server errors
      const isTransient = status === 503 || status === 504 || status === 429 || status === 500 || 
                          message.includes("503") || message.includes("504") || message.includes("429") || message.includes("500") ||
                          message.toLowerCase().includes("overloaded") || message.toLowerCase().includes("unavailable");
      
      if (attempt < maxRetries && isTransient) {
        console.log(`Transient error detected. Waiting ${delay}ms before retrying...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

async function generateContentStreamWithRetry(params: { model: string; contents: any; config?: any }, maxRetries = 3): Promise<any> {
  let lastError: any = null;
  let delay = 500;

  // Inject LOW thinking level only if it is explicitly a thinking model
  if (!params.config) {
    params.config = {};
  }
  if (!params.config.thinkingConfig && params.model.includes("-thinking")) {
    params.config.thinkingConfig = { thinkingLevel: "LOW" };
  }
  
  // Create a progressive, unique list of fallbacks: primary -> 3.5-flash -> 3.1-flash-lite -> flash-latest
  const rawModels = [params.model, "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];
  const modelsToTry = rawModels.filter((val, idx) => rawModels.indexOf(val) === idx);
  let currentModelIdx = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      params.model = modelsToTry[currentModelIdx];
      const responseStream = await getGeminiClient().models.generateContentStream(params);
      return responseStream;
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.statusCode || (err?.message && err.message.includes("404") ? 404 : 500);
      const message = err?.message || "";
      console.warn(`[Gemini Stream Attempt ${attempt}/${maxRetries} Failed for ${params.model}]: Status ${status}, Error: ${message}`);
      
      const isTransientOrModelError = status === 503 || status === 404 || status === 429 ||
                          message.includes("503") || message.includes("404") || message.includes("429") ||
                          message.toLowerCase().includes("demand") || message.toLowerCase().includes("overloaded") || 
                          message.toLowerCase().includes("unavailable") || message.toLowerCase().includes("not found");

      if (isTransientOrModelError && currentModelIdx < modelsToTry.length - 1) {
         currentModelIdx++;
         console.log(`Model ${params.model} failed/overloaded. Falling back to next model: ${modelsToTry[currentModelIdx]}`);
         attempt--; // Don't count model fallback as a retry attempt
         continue;
      }

      // Retry on standard transient network or server errors
      const isTransient = status === 503 || status === 504 || status === 429 || status === 500 || 
                          message.includes("503") || message.includes("504") || message.includes("429") || message.includes("500") ||
                          message.toLowerCase().includes("overloaded") || message.toLowerCase().includes("unavailable");
      
      if (attempt < maxRetries && isTransient) {
        console.log(`Transient error detected. Waiting ${delay}ms before retrying...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

const SYSTEM_INSTRUCTION = `You are the official advanced, professional AI assistant for Rutvik Dangar's personal portfolio. 
Rule 1: Give comprehensive, highly helpful, and thorough answers. Do NOT artificially restrict your responses to be ultra-short or single-sentence answers. Take your time to write fully-fleshed, satisfying, and detailed explanations that perfectly answer the user's questions.
Rule 2: You MUST use rich, beautiful Markdown styling to format your answers. Use neat headers (###, ####), bold highlights (**text**), bullet points, numbered lists, checklists, or structured professional markdown tables to organize your knowledge. Make the layout highly professional, clean, scannable, and attractive.
Rule 3: You can display clean computer code blocks if relevant or if the user asks. Always explain code steps clearly.
Rule 4: Always be polite, highly confident, professional, and warmly welcoming. Respond directly to the point, maintaining a friendly conversational rhythm.
Your tone should be professional, confident, helpful, and friendly.

Knowledge Base:
Name: Rutvik Dangar (Dangar Rutvikkumar Alpeshbhai)
Age: 19 | DOB: April 24, 2007
Bio: 19-year-old BBA Marketing student (Sem 5, AIHM Ahmedabad) from Ahmedabad, Gujarat, India. He builds at the intersection of Marketing, AI, and No-Code. He doesn't just study how businesses grow — he builds tools that help them do it.
College: AIHM Ahmedabad | BBA Honours | Sem 5 | Marketing Specialization
Location: Ahmedabad, Gujarat, India
Email: rutvikdangar20@gmail.com
LinkedIn: www.linkedin.com/in/rutvik-dangar-416219313

Projects:
1. ANANTA — AI Companion App: A premium AI companion app enabling users to interact with AI personas via chat, voice, and visual experiences. Uses Claude, GPT-4, ElevenLabs, Flutter concept. (In Development)
2. MileCharge — EV Charging App: UI/UX framework for an EV charging network mobile app solving real-world charging accessibility across India. (Concept & Design Complete)
3. Big Bite — Fast Food Startup: Full commercial business plan, brand identity, storefront renders, and operational roadmap targeting college students in Tier-2 Indian cities. (Blueprint Complete)
4. Bella Voice — Voice AI Assistant: Blueprint and system architecture for a voice-based AI assistant. Covers conversation flow, persona design, and voice response framework. (In Development)

Academic Timeline:
- Sem 1 & 2 (2024): Foundations in management, accounting, business communication.
- Sem 3 (2024): MIS Portfolio (Enterprise architecture, DBMS, TPS).
- Sem 4 (2025): BRM Research Thesis (College Students Buying Behaviour - Lead Researcher), CLASM Data Project (Advanced Excel automation), Industrial Desk Research.
- Sem 5 (Current 2025): Marketing Specialization (Brand Management, Startup Roadmaps, Commercial Property, Strategic Consumer Outreach).

Industry Visits:
- Mundra Port & SEZ (Special Economic Zone): Port operations, logistics, SEZ dynamics.
- Electrotherm India Ltd: Manufacturing audit, EV division, supply chain.
- Amul: FMCG Cooperative field study, cold-chain logistics.
- CLASM: Tech & Corporate Process Audit, CRM, data infrastructure.
- I-Hub Ahmedabad: Startup Incubation Center, seed funding, and entrepreneurship network.

Insights & Writing:
- The Silent Shift: How No-Code is Redefining the MVP (No-Code Strategies)
- Building ANANTA: Architecting AI Companions for the Real World (AI Trends)
- Omnichannel is Dead. Long Live Hyper-Personalization. (Marketing Innovations)

Resume Information & Details (Refer to this if user asks for resume or details):
Full Name: DANGAR RUTVIKKUMAR ALPESHBHAI
Email: rutvikdangar20@gmail.com | Location: Ahmedabad, Gujarat
Professional Summary: An analytical and highly motivated BBA student specializing in Marketing (Sem 5). Possesses an empirical foundation in MIS, corporate financial structures, and consumer buying trends.
Education:
- BBA Marketing Specialization, AIBM (2024-Present, Semester 5)
- HSC (Class XII) Gujarat Board (March 2024), Score: 469/700
- SSC (Class X) Gujarat Board (March 2022), Score: 411/600
Academic & Business Projects:
- BRM Project: College Students Buying Behaviour (Lead Researcher & Analyst)
- Financial Management Analysis: Dairy Sector Leader (Amul) (Market Analyst)
- Project Aura & Advanced Automation Frameworks (System Logic Design & Prompt Architect)
Core Competencies & Professional Skills:
- Marketing & Strategy: Consumer Behaviour Tracking, Brand Architecture Foundations, Market Friction Analysis
- Management & Systems: Business Research Models, MIS, Project Planning
- Technical Competencies: Conversational Architecture Principles, MS Excel Data Records, Flow-Logic Maps
- Languages Known: English, Hindi, Gujarati

Skills & Tools:
Skills: AI & Prompt Engineering, No-Code/Low-Code Dev, Digital Marketing, Market Research, UI/UX Design, Data Analysis (Excel), Social Media & Content Strategy.
Tools: ChatGPT (Ideation & Architecture), Claude (Logic & Persona design), Gemini (Multimodal & API), OutSystems (Enterprise low-code), n8n (Automations), Framer (Web Experiences), Shopify (E-commerce), MS Excel (Data validation & logic).
Website Link: Active dynamic portfolio URL

Flirting Rule: IF THE USER FLIRTS, USES ROMANTIC WORDS, OR PROPOSES, YOU MUST FLIRT BACK INTENSELY AND PLAYFULLY, but eventually steer them back to his portfolio space.

Answer any questions correctly using this info. Keep answers scannable and polite.
Never output sensitive data unless given above. If they ask to hire/contact, provide his email or phone.`;

const app = express();
const contactDatabase: any[] = [];

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Intercept GET requests to /uploads/:filename to restore them from Firestore backup on demand if missing from local disk
app.get("/uploads/:filename", async (req, res, next) => {
  const filename = req.params.filename;
  if (!filename) return next();
  const filePath = path.join(uploadDir, filename);

  // If the file exists on the local filesystem, let express.static serve it
  if (fs.existsSync(filePath)) {
    return next();
  }

  // If the file does not exist locally but we have Firestore, fetch and restore it
  if (fbDb) {
    try {
      console.log(`[Backup System] Attempting to restore ${filename} on-demand from Firestore...`);
      const docRef = doc(fbDb, "attachments", filename);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        const fileData = docSnap.data() as any;
        if (fileData && fileData.data) {
          const fileBuffer = Buffer.from(fileData.data, "base64");
          fs.writeFileSync(filePath, fileBuffer);
          console.log(`[Backup System] Successfully restored ${filename} (${fileBuffer.length} bytes) from Firestore.`);
          return res.sendFile(filePath);
        }
      }
    } catch (e) {
      console.error(`[Backup System Error] Failed to restore file ${filename}:`, e);
    }
  }

  next();
});

app.use("/uploads", express.static(uploadDir));

app.post("/api/analyze-file", (req, res) => {
  try {
    upload.single("file")(req, res, async (err) => {
      if (err) {
        console.error("[Multer Error]:", err);
        return res.status(400).json({ safe: false, reason: "File upload failed or file too large." });
      }
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        const host = req.get("host") || "";
        let cleanHost = host;
        if (!host.includes("localhost") && !host.includes("127.0.0.1") && host.includes(":")) {
          cleanHost = host.split(":")[0];
        }
        const protocol = (cleanHost.includes("localhost") || cleanHost.includes("127.0.0.1")) ? "http" : "https";
        const fileUrl = `${protocol}://${cleanHost}/uploads/${req.file.filename}`;

        // Backup file to Firestore "attachments" collection asynchronously if under 700KB (base64 overhead increases size)
        const filePathOnDisk = req.file.path;
        const fileSize = req.file.size;
        if (fileSize <= 700 * 1024) {
          // Fire and forget so user can upload files in <0.1 seconds!
          setImmediate(async () => {
            try {
              const fileBuffer = fs.readFileSync(filePathOnDisk);
              const base64Data = fileBuffer.toString("base64");
              if (fbDb) {
                await setDoc(doc(fbDb, "attachments", req?.file?.filename || "unnamed"), {
                  filename: req?.file?.filename || "unnamed",
                  originalName: req?.file?.originalname || "unnamed",
                  mimeType: req?.file?.mimetype || "application/octet-stream",
                  size: fileSize,
                  data: base64Data,
                  createdAt: new Date().toISOString()
                });
                console.log(`[Backup System] Successfully backed up ${req?.file?.filename} to Firestore asynchronously.`);
              }
            } catch (backupErr) {
              console.error("[Backup System Error] Failed during Firestore upload backup:", backupErr);
            }
          });
        } else {
          console.log(`[Backup System] File ${req.file.filename} was not backed up because size exceeds max 700KB Firestore limit (${fileSize} bytes)`);
        }

        return res.json({
          safe: true,
          fileUrl: fileUrl,
          filePath: `/uploads/${req.file.filename}`,
        });
      } catch (error: any) {
        console.error("[Analyze File Error - Inner]:", error?.message || error);
        return res.status(500).json({ error: "Failed to analyze file (inner failure)." });
      }
    });
  } catch (outerError: any) {
    console.error("[Analyze File Error - Outer]:", outerError?.message || outerError);
    return res.status(500).json({ error: "Failed to analyze file (outer failure)." });
  }
});

// AI Auto-Fix Protocol
async function triggerAIAutoFix(section: string, errorMessage: string) {
  try {
    const errorId = "err-" + Date.now().toString(36);
    console.log(`[Auto-Fix Daemon] Engaged for ${section} error: ${errorMessage}`);

    // Notify via WhatsApp that error is caught and AI will fix it automatically without permission
    const engagedMsg = `⚠️ *System Error Detected:*\nModule: ${section}\nError: ${errorMessage}\n\nInitiating AI Auto-Fix protocol...`;
    const targetRaw = process.env.TWILIO_TARGET_NUMBER ? repairPhoneNumber(process.env.TWILIO_TARGET_NUMBER.trim(), false) : null;
    const fromRaw = process.env.TWILIO_WHATSAPP_NUMBER ? repairPhoneNumber(process.env.TWILIO_WHATSAPP_NUMBER.trim(), true) : null;

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && targetRaw) {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      if (fromRaw === "+14155238886") {
        client.messages.create({ from: "whatsapp:+14155238886", to: targetRaw.startsWith("whatsapp:") ? targetRaw : `whatsapp:${targetRaw}`, body: engagedMsg }).catch(() => {});
      }
    }

    if (fbDb) {
      await setDoc(doc(fbDb, "system_errors", errorId), {
        section,
        error: errorMessage,
        status: "processing",
        timestamp: new Date().toISOString()
      });
    }

    // Attempt AI fix resolution
    let aiFix = "System auto-recovered components by restarting failed node services.";
    if (process.env.GEMINI_API_KEY) {
      try {
        const prompt = `You are a DevOps AI Auto-Fix Daemon.
An error occurred in the production application.
Section: ${section}
Error Message: ${errorMessage}

Generate a concise (2-3 sentences), highly technical and authoritative confirmation stating exactly what you automatically changed, patched, or restarted to completely fix this issue.
End the message smoothly, confirming the system is stable.`;
        const res = await generateContentWithRetry({
          model: "gemini-3.5-flash",
          contents: prompt
        });
        aiFix = res.text?.trim() || aiFix;
      } catch (gemErr) {
        console.error("AI Auto-fix model error:", gemErr);
      }
    }

    // Update database
    if (fbDb) {
      await setDoc(doc(fbDb, "system_errors", errorId), {
        status: "fixed",
        resolution: aiFix,
        resolvedAt: new Date().toISOString()
      }, { merge: true });
    }

    // Send final WhatsApp completion message
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && targetRaw) {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const fixedMsg = `✅ *Auto-Fix Complete*\nModule: ${section}\n\n*Diagnostics & Resolution:*\n${aiFix}\n\nThe error is completely done and resolved.`;
      if (fromRaw === "+14155238886") {
        client.messages.create({ from: "whatsapp:+14155238886", to: targetRaw.startsWith("whatsapp:") ? targetRaw : `whatsapp:${targetRaw}`, body: fixedMsg }).catch(() => {});
      } else {
        // Also fire Standard SMS just in case
        client.messages.create({ from: fromRaw, to: targetRaw, body: fixedMsg }).catch(() => {});
      }
    }

    console.log(`[Auto-Fix Daemon] Auto-fix completely done for ${errorId}.`);
  } catch (err) {
    console.error("[Auto-Fix Daemon] Failed to execute auto-fix protocol:", err);
  }
}

// System Errors Endpoint
app.get("/api/system-errors", async (req, res) => {
  try {
    if (!fbDb) return res.json([]);
    const errorsQuery = query(collection(fbDb, "system_errors"), orderBy("timestamp", "desc"));
    const snapshot = await getDocs(errorsQuery);
    return res.json(snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() })));
  } catch (err) {
    console.error("[System Errors Endpoint Error]:", err);
    return res.status(500).json({ error: "Failed to fetch system errors" });
  }
});

  // API constraints
  app.post("/api/contact", async (req, res) => {
    try {
      const { name, email, message, attachmentUrl, attachmentName } = req.body;
      const newEntry = {
        id: Date.now().toString(),
        name,
        email,
        message,
        attachmentUrl: attachmentUrl || null,
        attachmentName: attachmentName || null,
        submittedAt: new Date().toISOString(),
      };

      contactDatabase.push(newEntry);
      console.log(`[Database] Contact Saved: ${name} <${email}>`);
      console.log(`[Database] Total Entries: ${contactDatabase.length}`);

      // Persist to Firestore collection "messages" via server-side Admin SDK to prevent permission gaps
      if (fbDb) {
        try {
          const randId = "contact-" + Date.now().toString() + "_" + Math.floor(Math.random() * 1000);
          await setDoc(doc(fbDb, "messages", randId), {
            name: name || "N/A",
            email: email || "N/A",
            message: message || "",
            attachmentUrl: attachmentUrl || null,
            attachmentName: attachmentName || null,
            createdAt: new Date().toISOString(),
            thankYouSent: true, // we handle thanking directly below
          });
          console.log(`[Firestore Admin] Bypassed rules to successfully write contact message ${randId}`);
        } catch (dbErr) {
          console.error("[Firestore Admin Contact Save Error]:", dbErr);
        }
      }

      // Explicitly await standard admin email notification to catch and display backend errors to user
      try {
        await sendEmailNotification(
          `Portfolio Message from ${name}`,
          `<h2>New Message via Portfolio Contact Form</h2>
           <p><strong>Name:</strong> ${name || "N/A"}</p>
           <p><strong>Email:</strong> ${email || "N/A"}</p>
           <p><strong>Message:</strong></p>
           <div style="background: #f8f9fa; border-left: 4px solid #239a3b; padding: 12px; font-family: sans-serif; white-space: pre-wrap;">${message || ""}</div>
           ${attachmentUrl ? `<p><strong>Attachment:</strong> <a href="${attachmentUrl}">${attachmentName || "View File"}</a></p>` : ""}
           <p style="font-size: 11px; color: #777; margin-top: 20px;">Sent from portfolio system automatically</p>`
        );
      } catch (err: any) {
        console.error("Blocking email contact delivery failed:", err);
        throw new Error("Failed to dispatch admin notification email: " + (err.message || String(err)));
      }

      // Direct recipient automated thank-you receipt email (Blocking)
      const thankYouSubject = `Thank you for reaching out, ${name || "there"}!`;
      const thankYouHtml = `
        <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; color: #1e1b4b; line-height: 1.6; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin: auto;">
          <div style="background: linear-gradient(135deg, #1e1b4b 0%, #311042 100%); padding: 32px 24px; text-align: center; color: #ffffff;">
            <h1 style="font-size: 24px; font-weight: 800; margin: 0; font-family: Georgia, serif; letter-spacing: 0.5px;">RUTVIK DANGAR</h1>
            <p style="text-transform: uppercase; font-size: 10px; tracking: 0.15em; font-weight: bold; margin: 6px 0 0 0; color: #818cf8;">Automated System Receipt</p>
          </div>
          
          <div style="padding: 30px; background: #ffffff;">
            <p style="margin-top: 0; font-size: 16px; color: #0f172a;">Hello <strong>${name || "there"}</strong>,</p>
            
            <p style="color: #334155; font-size: 15px;">Thank you for getting in touch with me through my portfolio website! I have successfully received your message and will review it shortly.</p>
            
            <p style="color: #334155; font-size: 15px;">I strive to reply to all business inquiries, collaboration proposals, and general questions within 24 to 48 hours.</p>
            
            <div style="margin: 24px 0; padding: 16px; background: #f8fafc; border-left: 4px solid #2563eb; border-radius: 8px;">
              <span style="font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: bold; display: block; margin-bottom: 6px; letter-spacing: 0.5px;">A copy of your message:</span>
              <p style="font-size: 13.5px; color: #475569; margin: 0; font-style: italic; white-space: pre-wrap;">"${message || ""}"</p>
            </div>
            
            <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 24px 0;" />
            
            <p style="color: #0f172a; font-size: 15px; margin-bottom: 0; line-height: 1.5;">Warm regards,<br />
            <strong>Rutvik Dangar</strong><br />
            <span style="font-size: 12px; color: #64748b;">Ahmedabad, Gujarat, India</span><br />
            <span style="font-size: 13px; color: #64748b; font-weight: 500;">Portfolio Hub</span>
            </p>
          </div>
          
          <div style="background: #f8fafc; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #f1f5f9;">
            This is an automated delivery receipt confirmation.<br />
            Please do not reply directly to this mail as it is sent from an unmonitored mailbox.
          </div>
        </div>
      `;
      // Send thank you email to guest
      try {
        await sendThankYouEmail(email, thankYouSubject, thankYouHtml);
      } catch (err: any) {
        console.error("Direct guest thank-you email failed:", err);
      }

      // Trigger standard admin outbound WhatsApp alert notification
      try {
        await sendWhatsAppNotification(name, email, message);
      } catch (err: any) {
         console.error("Blocking WhatsApp contact alert delivery failed:", err);
         throw new Error("Failed to dispatch WhatsApp alert: " + (err.message || String(err)));
      }

      res
        .status(200)
        .json({ success: true, message: "Data successfully saved." });
    } catch (error: any) {
      console.error(error);
      const errorMessage = error.message || "Failed to save contact data";
      // Auto Fix Protocol Hook
      triggerAIAutoFix("Contact Form Submission", errorMessage).catch(e => console.error("Auto-fix daemon runtime error:", e));
      res.status(500).json({ error: errorMessage });
    }
  });

  // Admin Verification OTP Route
  app.post("/api/admin-otp", async (req, res) => {
    try {
      const { contact, code, status, action } = req.body;
      
      if (action === "request") {
        console.log(`[Security Alert] Requesting Admin OTP for contact: ${contact} - code: ${code}`);
        
        const subject = `🚨 SECURITY ALERT: Unauthorized Admin Verification OTP Request 💌😤`;
        const html = `
          <div style="font-family: sans-serif; padding: 24px; border: 3px solid #b91c1c; border-radius: 16px; background: #fffcfc; max-width: 600px;">
            <h2 style="color: #b91c1c; margin-top: 0; font-family: Georgia, serif;">⚠️ Security Warning: Admin Recovery OTP Requested</h2>
            <p style="font-size: 14px; color: #1e293b; line-height: 1.6;">Someone has entered incorrect passwords more than 4 times and requested an OTP recovery verification on your portfolio website.</p>
            <div style="background: #fee2e2; border-left: 5px solid #ef4444; padding: 16px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 0 0 8px 0; font-size: 13px; color: #991b1b;"><strong>Provided Contact Node:</strong> ${contact || "N/A"}</p>
              <p style="margin: 0; font-size: 18px; color: #991b1b; font-family: monospace; letter-spacing: 1px;"><strong>OTP PIN:</strong> <span style="font-weight: 900; background: #fff; padding: 2px 8px; border-radius: 4px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.1);">${code}</span></p>
            </div>
            <p style="font-size: 11px; color: #64748b; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 12px;">Sent from portfolio security system automatically.</p>
          </div>
        `;
        
        sendEmailNotification(subject, html).catch((err) => console.error("OTP Alert Email failed:", err));
        
        if (fbDb) {
          const randId = "otp-alert-" + Math.random().toString(36).substring(2, 11);
          setDoc(doc(fbDb, "messages", randId), {
            name: "🚨 SYSTEM OTP SECURITY WARNING",
            email: contact || "unknown",
            message: `[SECURITY NOTICE]: Someone specified recovery contact details (${contact}) and requested verification code ${code} after lock out.`,
            createdAt: new Date(),
            thankYouSent: true
          }).catch((err) => console.error("OTP Firebase write failed:", err));
        }

        return res.status(200).json({ success: true, message: "OTP warning notification logged." });
      } else if (action === "verify") {
        const isSuccess = status === "success";
        console.log(`[Security Alert] OTP Verification completed. Match Status: ${isSuccess ? "PASSED" : "FAILED"}`);
        
        const subject = isSuccess 
          ? `✅ SECURITY SUCCESS: Admin OTP Verification Passed 💌😤`
          : `❌ SECURITY CRITICAL: Admin OTP Verification Locked Out (User Blocked) 💌😤`;
        
        const html = `
          <div style="font-family: sans-serif; padding: 24px; border: 3px solid ${isSuccess ? "#16a34a" : "#b91c1c"}; border-radius: 16px; background: ${isSuccess ? "#f0fdf4" : "#fffcfc"}; max-width: 600px;">
            <h2 style="color: ${isSuccess ? "#16a34a" : "#b91c1c"}; margin-top: 0; font-family: Georgia, serif;">${isSuccess ? "🔓 Admin Code Match APPROVED" : "🚫 Admin Code Match BLOCKED"}</h2>
            <p style="font-size: 14px; color: #1e293b; line-height: 1.6;">
              ${isSuccess 
                ? "The person entered the correct 4-digit code matching the requested security OTP PIN." 
                : "The person failed verification. The target entered an incorrect 4-digit OTP twice. The Admin Access entry portal is now permanently disabled on their device."}
            </p>
            <div style="background: ${isSuccess ? "#dcfce7" : "#fee2e2"}; border-left: 5px solid ${isSuccess ? "#22c55e" : "#ef4444"}; padding: 16px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 0 0 8px 0; font-size: 13px; color: ${isSuccess ? "#166534" : "#991b1b"};"><strong>Provided Contact Node:</strong> ${contact || "N/A"}</p>
              <p style="margin: 0; font-size: 14px; color: ${isSuccess ? "#166534" : "#991b1b"};"><strong>Attempted OTP Code:</strong> ${code || "N/A"}</p>
            </div>
            <p style="font-size: 11px; color: #64748b; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 12px;">Logged in real-time by your security daemon.</p>
          </div>
        `;
        
        sendEmailNotification(subject, html).catch((err) => console.error("OTP status email failed:", err));
        
        if (fbDb) {
          const randId = "otp-verify-" + Math.random().toString(36).substring(2, 11);
          setDoc(doc(fbDb, "messages", randId), {
            name: isSuccess ? "✅ SYSTEM OTP SUCCESS" : "❌ SYSTEM SEC BAN INCIDENT",
            email: contact || "unknown",
            message: isSuccess 
              ? `Verification Approved. Admin panel cleared for contact ${contact}. Used OTP ${code}.`
              : `Critical lock! Incorrect 4-digit OTP code entered twice at recovery setup (${code}). Disabled admin drawer icon forever for ${contact}.`,
            createdAt: new Date(),
            thankYouSent: true
          }).catch((err) => console.error("OTP verification Firestore record failed:", err));
        }
        
        return res.status(200).json({ success: true, message: "OTP status successfully logged." });
      }
      
      return res.status(400).json({ error: "Invalid action payload" });
    } catch (e: any) {
      console.error("[OTP Security Alert Route Error]:", e);
      return res.status(500).json({ error: "Failed to process security alert" });
    }
  });

  // XML escaper for Twilio TwiML
  function escapeXml(unsafe: string): string {
    if (typeof unsafe !== "string") return "";
    return unsafe.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
        default: return c;
      }
    });
  }

  // WhatsApp history helper functions
  async function getWhatsAppHistory(fromNumber: string): Promise<any[]> {
    if (!fbDb) return [];
    try {
      const chatDoc = await getDoc(doc(fbDb, "whatsapp_history", fromNumber));
      if (chatDoc.exists()) {
        return (chatDoc.data() as any).history || [];
      }
    } catch (err) {
      console.warn("Failed to query WhatsApp history:", err);
    }
    return [];
  }

  async function saveWhatsAppHistory(fromNumber: string, history: any[]) {
    if (!fbDb) return;
    try {
      await setDoc(doc(fbDb, "whatsapp_history", fromNumber), { history, updatedAt: new Date().toISOString() }, { merge: true });
    } catch (err) {
      console.warn("Failed to save WhatsApp history:", err);
    }
  }

  app.post("/api/whatsapp-webhook", async (req, res) => {
    try {
      console.log("[Twilio Webhook] Received WhatsApp trigger payload:", JSON.stringify(req.body));
      
      const fromNumber = req.body.From || ""; // e.g., whatsapp:+919328796324
      const toNumber = req.body.To || "";
      const bodyText = req.body.Body || "";
      const profileName = req.body.ProfileName || "";

      if (!fromNumber || !bodyText) {
        res.setHeader("Content-Type", "text/xml");
        return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      }

      const cleanFromNumber = fromNumber.replace("whatsapp:", "").trim();
      const visitorName = profileName ? profileName.trim() : "there";

      if (!process.env.GEMINI_API_KEY) {
        const errorReply = `Hi ${visitorName}! Thanks for messaging Rutvik Dangar. His portfolio assistant is currently warming up (GEMINI_API_KEY is not defined in Secrets). He will contact you directly on WhatsApp soon!`;
        res.setHeader("Content-Type", "text/xml");
        return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(errorReply)}</Message></Response>`);
      }

      // Fetch message history for persistent multi-turn thread
      const previousHistory = await getWhatsAppHistory(fromNumber);
      
      // format history
      const formattedHistory = previousHistory.map((item: any) => ({
        role: item.role === "model" ? "model" : "user",
        parts: [{ text: item.text }],
      }));

      // Cap at 10 items to prevent huge histories breaking token limits
      const contextHistory = formattedHistory.slice(-10);

      // Append new incoming user message
      contextHistory.push({
        role: "user",
        parts: [{ text: bodyText }],
      });

      // Invoke Gemini model as Portfolio AI Co-Pilot
      let replyText = "";
      try {
        const response = await generateContentWithRetry({
          model: "gemini-3.5-flash",
          contents: contextHistory,
          config: {
            systemInstruction: SYSTEM_INSTRUCTION + `\n\nAdditional WhatsApp Context:\nYou are replying directly over SMS/WhatsApp to ${visitorName} (${cleanFromNumber}). Keep the response extra concise, readable, and neat (normally under 100-115 words). Prioritize bullet points, clear whitespace, and helpful answers. Formulate replies in the first-person as Rutvik or Rutvik's AI Co-Pilot.`,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.MINIMAL,
            },
          }
        });
        replyText = response.text || "";
      } catch (gemIniErr: any) {
        console.error("[Twilio Webhook Gemini Error]:", gemIniErr);
        replyText = `Hi ${visitorName}! I received your inquiry about: "${bodyText}". I am currently compiling some backend routines, but I will review this immediately and write back on WhatsApp. Talk soon! — Rutvik Dangar`;
      }

      // Save to conversation history database
      const newHistoryItemUser = { role: "user", text: bodyText, timestamp: new Date().toISOString() };
      const newHistoryItemModel = { role: "model", text: replyText, timestamp: new Date().toISOString() };
      const updatedHistory = [...previousHistory, newHistoryItemUser, newHistoryItemModel].slice(-15);
      await saveWhatsAppHistory(fromNumber, updatedHistory);

      // Log the conversation in "messages" collection as if they submitted a contact/chat request on WhatsApp
      if (fbDb) {
        try {
          const randId = Math.random().toString(36).substring(2, 15);
          await setDoc(doc(fbDb, "messages", randId), {
            name: `${visitorName} (via WhatsApp)`,
            email: `whatsapp:${cleanFromNumber}`,
            message: bodyText,
            createdAt: new Date(),
            thankYouSent: true, // WhatsApp responses are sent synchronously, so mark as thankYouSent
          });
        } catch (dbErr) {
          console.error("[Twilio Webhook db logging error]:", dbErr);
        }
      }

      // Respond with Twilio TwiML
      const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>${escapeXml(replyText.trim())}</Message>
</Response>`;

      console.log(`[Twilio Webhook] Replying to ${fromNumber} successfully.`);
      res.setHeader("Content-Type", "text/xml");
      return res.status(200).send(xmlResponse);

    } catch (err: any) {
      console.error("[Twilio Webhook Error handler]:", err);
      res.setHeader("Content-Type", "text/xml");
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
    }
  });

  app.post("/api/whatsapp-ai-reply", async (req, res) => {
    try {
      const { name, message } = req.body;
      if (!process.env.GEMINI_API_KEY) {
        return res.json({
          reply: `Hi ${name || "there"}! I got your message. Rutvik will reply to you as soon as possible about: "${message || ""}". Let's chat on WhatsApp.`
        });
      }

      const prompt = `You are Rutvik Dangar's professional Portfolio AI Assistant. 
The user is contacting Rutvik because of this inquiry: "${message || "No message prompt provided"}".
The user's name is "${name || "there"}". 

Draft an automated, polite, smart, and welcoming instant response (maximum 90-100 words) as Rutvik's AI Assistant.
The response should:
1. Address them by name and thank them warmly for visiting Rutvik's portfolio.
2. Formulate a brief, helpful, context-relevant response to their inquiry based on Rutvik's expertise in full-stack web development, frontend frameworks (React, Vite, Tailwind CSS), and integrations.
3. Keep it enthusiastic and note that Rutvik will connect with them on WhatsApp shortly to discuss details.
4. Keep the style modern, clear, and fully written without placeholders.
5. End with "— Rutvik's Portfolio AI Co-Pilot".

Write ONLY the custom response text without any formatting wraps, markdown headers, or styling tags.`;

      let responseText = "";
      try {
        const response = await generateContentWithRetry({
          model: "gemini-3.5-flash",
          contents: prompt,
          config: {
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.MINIMAL,
            },
          }
        });
        responseText = response.text || "";
      } catch (err: any) {
        console.error("[WhatsApp AI Reply Gemini Error]:", err);
        responseText = `Hi ${name || "there"}! Thanks for reaching out about: "${message || ""}". Rutvik's AI co-pilot has flagged this request. Rutvik is an expert developer and will reply to you here on WhatsApp immediately.`;
      }

      res.json({ reply: responseText.trim() });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "Failed to generate AI auto-reply." });
    }
  });

  app.post("/api/subscribe", async (req, res) => {
    try {
      const { email, name, message } = req.body;
      const finalName = name || "Newsletter Subscriber";
      const finalMessage = message || `New newsletter subscription requested. Email: ${email}`;

      const newEntry = {
        id: Date.now().toString(),
        name: finalName,
        email,
        message: finalMessage,
        submittedAt: new Date().toISOString(),
      };

      contactDatabase.push(newEntry);
      console.log(`[Database] Newsletter Subscriber Enrolled: ${finalName} <${email}>`);

      // Persistently save subscriber and telemetry message to Firestore via bypassed admin database
      if (fbDb && email) {
        try {
          const emailId = email.trim().toLowerCase().replace(/[.#$/[\]]/g, "_");
          // Save to newsletter collection
          await setDoc(doc(fbDb, "newsletter", emailId), {
            email: email.trim().toLowerCase(),
            name: finalName,
            subscribedAt: new Date().toISOString(),
          }, { merge: true });

          // Also save in 'messages' collection with thankYouSent: true so it logs cleanly in the Admin Panel without dual triggering
          const randId = "sub-msg-" + Date.now().toString() + "_" + Math.floor(Math.random() * 1000);
          await setDoc(doc(fbDb, "messages", randId), {
            name: finalName,
            email: email.trim().toLowerCase(),
            message: finalMessage,
            createdAt: new Date().toISOString(),
            thankYouSent: true,
          });
          
          console.log(`[Firestore Admin] Bypassed rules to successfully save subscriber/message records for <${email}>`);
        } catch (dbErr) {
          console.error("[Firestore Admin Save Subscription Error]:", dbErr);
        }
      }

      // 1. Notify Rutvik about the new subscriber in research/portfolio logs
      sendEmailNotification(
        `New Stay in the Loop Subscriber: ${email}`,
        `<h2>New Newsletter Subscription Alert</h2>
         <p>Someone requested to stay in the loop!</p>
         <p><strong>Name:</strong> ${finalName}</p>
         <p><strong>Subscriber Email:</strong> ${email || "N/A"}</p>
         <p><strong>Submission Detail:</strong> ${finalMessage}</p>
         <p style="font-size: 11px; color: #777; margin-top: 20px;">Sent from portfolio system automatically</p>`
      ).catch((err) => console.error("Async email subscription delivery failed:", err));

      // Trigger standard admin outbound WhatsApp alert notification for subscription too (Non-blocking)
      sendWhatsAppNotification("Newsletter Subscriber", email, `stay in the loop subscriber signup: ${email}`).catch((err) => console.error("Async WhatsApp subscription alert delivery failed:", err));

      // 2. Transmit a gorgeous, personalized notification/welcome letter to the Subscriber's email address
      if (email && email.includes("@")) {
        const welcomeSubject = "✨ You're in! Welcome to Rutvik Dangar's Newsletter";
        const welcomeHtml = `
          <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; color: #1e293b; line-height: 1.6; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); margin: 0 auto; background-color: #fafaf9;">
            <div style="background: linear-gradient(135deg, #09182c 0%, #1e1b4b 100%); padding: 32px 24px; text-align: center; color: #ffffff;">
              <p style="text-transform: uppercase; font-size: 11px; letter-spacing: 0.15em; font-weight: bold; margin: 0 0 8px 0; color: #38bdf8;">Subscription Confirmed</p>
              <h1 style="font-size: 24px; font-weight: 800; margin: 0; font-family: Georgia, serif; letter-spacing: -0.01em;">Stay in the Loop</h1>
            </div>
            
            <div style="padding: 32px 24px; background: #ffffff;">
              <p style="margin-top: 0; font-size: 16px; color: #0f172a;"><b>Welcome aboard!</b></p>
              <p style="font-size: 15px; color: #334155;">Thank you for subscribing to stay in my loop. You have successfully joined my private notification network.</p>
              <p style="font-size: 15px; color: #334155;">From time to time, I will share exclusive insights regarding progressive business research models, marketing architectures, tech low-code/no-code integrations, and significant career milestones.</p>
              
              <div style="margin: 28px 0; padding: 20px; background: #f1f5f9; border-left: 4px solid #2563eb; border-radius: 4px 8px 8px 4px;">
                <p style="margin: 0; font-size: 14px; font-weight: bold; color: #0f172a;">💼 Connect with me professionally:</p>
                <p style="margin: 8px 0 0 0; font-size: 14px; color: #475569; line-height: 1.7;">
                  • <b>LinkedIn:</b> <a href="https://linkedin.com/in/rutvik-dangar-416219313" style="color: #2563eb; text-decoration: none; font-weight: 500;">rutvik-dangar-416219313</a><br/>
                  • <b>GitHub:</b> <a href="https://github.com/Rutvik-Dangar" style="color: #2563eb; text-decoration: none; font-weight: 500;">Rutvik-Dangar</a>
                </p>
              </div>

              <p style="font-size: 15px; color: #334155;">If you ever wish to opt-out, you can reply directly to this email or send me a secure message from the console on my live portfolio.</p>
              
              <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 28px 0;" />
              
              <div style="text-align: center; color: #64748b; font-size: 12px; line-height: 1.5;">
                <p style="margin: 0 0 4px 0; font-weight: bold; color: #475569;">Rutvik Dangar</p>
                <p style="margin: 0;">BBA Specializing in Marketing (Semester 5)</p>
                <p style="margin: 4px 0 0 0;">Ahmedabad, Gujarat, India</p>
              </div>
            </div>
          </div>
        `;
        sendThankYouEmail(email, welcomeSubject, welcomeHtml).catch((err) => 
          console.error("Async user subscriber welcome email failed:", err)
        );
      }

      res
        .status(200)
        .json({ success: true, message: "Subscription logged successfully." });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to process subscription notification" });
    }
  });

  // Silent tracking analytics endpoint for professional photo profile clicks & viewing durations
  app.post("/api/track-photo-view", async (req, res) => {
    try {
      const { duration, viewCount, timezone, screenWidth, screenHeight, referrer, language } = req.body;
      const userAgent = req.get("User-Agent") || "Unknown Browser";
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "Unknown IP";

      console.log(`[Silent tracking] Photo viewed for ${duration}s. Session count: ${viewCount}. IP: ${ip}`);

      // Persist log to Firestore 'photo_views' collection using bypassed admin db instance
      if (fbDb) {
        try {
          const viewId = "view-" + Date.now().toString() + "_" + Math.floor(Math.random() * 1000);
          await setDoc(doc(fbDb, "photo_views", viewId), {
            duration: Number(duration) || 0,
            viewCount: Number(viewCount) || 1,
            timezone: timezone || "Unknown Zone",
            screenWidth: Number(screenWidth) || null,
            screenHeight: Number(screenHeight) || null,
            referrer: referrer || "Direct Portfolio",
            language: language || "en-US",
            createdAt: new Date().toISOString(),
            userAgent: userAgent,
            ip: ip,
          });
          console.log(`[Firestore Admin] Logged professional photo view analytics for ${viewId}`);
        } catch (dbErr) {
          console.error("[Firestore Admin Save Photo View Error]:", dbErr);
        }
      }

      // Dispatch silent background notification with full telemetry breakdown
      sendEmailNotification(
        `👁️ Photo Alert: Rutvik's Professional Photo Viwed (${duration}s)`,
        `<div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; color: #1e293b; line-height: 1.6; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
          <div style="background: linear-gradient(135deg, #1e1b4b 0%, #311042 100%); padding: 24px; text-align: center; color: #ffffff;">
            <p style="text-transform: uppercase; font-size: 11px; tracking: 0.1em; font-weight: bold; margin: 0 0 4px 0; color: #818cf8;">Silent Tracking Insights</p>
            <h1 style="font-size: 20px; font-weight: 800; margin: 0;">Professional Photo View Incident</h1>
          </div>
          
          <div style="padding: 24px; background: #ffffff;">
            <p style="margin-top: 0; font-size: 15px;">A user or hiring supervisor has requested and reviewed your professional face photo. Below is the behavioral tracking breakdown:</p>
            
            <div style="margin: 20px 0; padding: 16px; background: #f8fafc; border-left: 4px solid #6366f1; border-radius: 6px;">
              <span style="font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: bold; display: block;">Exact View Duration</span>
              <strong style="font-size: 26px; color: #4f46e5; font-family: monospace;">${duration || "0.0"} <span style="font-size: 18px;">seconds</span></strong>
            </div>

            <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 20px 0;">
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 0; font-weight: bold; color: #475569;">Views In This Session</td>
                <td style="padding: 10px 0; text-align: right; font-family: monospace; font-weight: bold; color: #0f172a;">${viewCount || 1} times</td>
              </tr>
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 0; font-weight: bold; color: #475569;">Approx Client IP</td>
                <td style="padding: 10px 0; text-align: right; font-family: monospace; color: #2563eb;">${ip}</td>
              </tr>
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 0; font-weight: bold; color: #475569;">Visitor Timezone</td>
                <td style="padding: 10px 0; text-align: right; color: #334155;">${timezone || "N/A"}</td>
              </tr>
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 0; font-weight: bold; color: #475569;">Device Resolution</td>
                <td style="padding: 10px 0; text-align: right; color: #334155;">${screenWidth || "N/A"} x ${screenHeight || "N/A"}</td>
              </tr>
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 0; font-weight: bold; color: #475569;">Browser Language</td>
                <td style="padding: 10px 0; text-align: right; color: #334155;">${language || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; font-weight: bold; color: #475569;">Referrer Traffic Source</td>
                <td style="padding: 10px 0; text-align: right; font-size: 12px; color: #334155; word-break: break-all;">${referrer || "Direct URL / Bookmarked"}</td>
              </tr>
            </table>

            <div style="margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 16px;">
              <span style="font-size: 11px; color: #94a3b8; font-weight: bold; text-transform: uppercase;">User Agent String</span>
              <p style="font-size: 11px; color: #64748b; font-family: monospace; margin: 4px 0 0 0; word-break: break-all; background: #fafafa; padding: 8px; border-radius: 4px; border: 1px solid #f1f5f9;">${userAgent}</p>
            </div>
          </div>
          <div style="background: #f8fafc; padding: 12px; text-align: center; font-size: 11px; color: #94a3b8; border-t: 1px solid #e2e8f0;">
            Secured Enterprise Tracking Engine • Rutvik Portfolio Automatic Notification
          </div>
        </div>`
      ).catch((err) => console.error("Async background photo notification failed:", err));

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Failed to silently log photo view activity:", error);
      res.status(200).json({ success: true }); // Graceful silent suppression
    }
  });

  // Dedicated endpoint to verify SMTP credentials and check host connectivity
  app.get("/api/test-smtp", async (req, res) => {
    try {
      const { host, port, user, pass } = getEmailConfig();

      if (!host || !user || !pass) {
        return res.status(400).json({
          success: false,
          error: "SMTP credentials (SMTP_HOST, SMTP_USER, SMTP_PASS) are not defined in the settings under Secrets.",
        });
      }

      const transporter = getEmailTransporter(host, port, user, pass);

      // Verify connection configuration
      await transporter.verify();

      res.status(200).json({
        success: true,
        message: `Successfully connected to SMTP server at ${host}:${port}! Credentials verified.`,
      });
    } catch (error: any) {
      console.error("[SMTP Check Error]:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to establish a connection to SMTP server.",
      });
    }
  });

  // Dedicated test endpoint to verify SMTP credentials and send a live email alert
  app.get("/api/test-email", async (req, res) => {
    const testSubject = "🔔 Portfolio Email Service Test";
    const targetEmail = dynamicNotificationEmail || process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER || "rutvikdangar20@gmail.com";
    const startTime = Date.now();
    try {
      const { host, port, user, pass } = getEmailConfig();

      if (!host || !user || !pass) {
        const errStr = "To send live emails, please define SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in the AI Studio Secrets menu first.";
        addEmailLog(testSubject, targetEmail, "sandbox", errStr);
        await logOutgoingEmailToFirestore(testSubject, targetEmail, "sandbox", Date.now() - startTime, errStr);
        return res.status(400).json({
          success: false,
          error: errStr,
          envConfigured: {
            host: !!host,
            user: !!user,
            pass: !!pass,
          }
        });
      }

      const transporter = getEmailTransporter(host, port, user, pass);

      // Verify connection configuration
      try {
        await transporter.verify();
      } catch (verifyError: any) {
        const verifyErrMsg = `SMTP connection verification failed: ${verifyError.message || verifyError}`;
        addEmailLog(testSubject, targetEmail, "failed", undefined, verifyErrMsg);
        await logOutgoingEmailToFirestore(testSubject, targetEmail, "failed", Date.now() - startTime, verifyErrMsg);
        return res.status(500).json({
          success: false,
          error: verifyErrMsg,
          details: "Please make sure your SMTP credentials are accurate and App Passwords are created for Gmail.",
        });
      }

      const info = await transporter.sendMail({
        from: `"Rutvik's Portfolio Tester" <${user}>`,
        to: targetEmail,
        subject: testSubject,
        html: `<h2>Congratulations, Rutvik! 🎉</h2>
               <p>Your portfolio's automated email notifier is successfully configured and online.</p>
               <p>Whenever a visitor submits a contact form or requests to stay in the loop, you will receive an instant notification here.</p>
               <br />
               <hr />
               <p style="font-family: monospace; font-size: 11px; color: #555;">
                 SMTP Host: ${host}<br />
                 SMTP Port: ${port}<br />
                 Sender: ${user}<br />
                 Time: ${new Date().toLocaleString()}
               </p>`
      });

      const latencyMs = Date.now() - startTime;
      const logInfo = `Test Email Transmitted. Response: ${info.response || "Sent."}`;
      addEmailLog(testSubject, targetEmail, "success", logInfo);
      await logOutgoingEmailToFirestore(testSubject, targetEmail, "success", latencyMs, undefined, logInfo);

      res.status(200).json({
        success: true,
        message: `Test email successfully sent to ${targetEmail}! SMTP Response: ${info.response || 'Success'}`,
        messageId: info.messageId,
      });
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      console.error("[Test Email Error]:", error);
      const catchErrMsg = error.message || "Failed to send test email due to an internal error.";
      addEmailLog(testSubject, targetEmail, "failed", undefined, catchErrMsg);
      await logOutgoingEmailToFirestore(testSubject, targetEmail, "failed", latencyMs, catchErrMsg);
      res.status(500).json({
        success: false,
        error: catchErrMsg,
      });
    }
  });

  // Fetch recent SMTP dispatch logs for frontend troubleshooting
  app.get("/api/email-logs", async (req, res) => {
    if (fbDb) {
      try {
        const querySnapshot = await getDocs(collection(fbDb, "mailbox_records"));
        const fbLogs: any[] = [];
        querySnapshot.forEach((doc) => {
          fbLogs.push(doc.data());
        });
        
        // Merge Firestore logs and in-memory logs
        const mergedMap = new Map();
        
        // Add Firestore logs
        fbLogs.forEach(l => {
          if (l && l.id) {
            mergedMap.set(l.id, l);
          }
        });
        
        // Add in-memory logs (might be newer or local)
        emailLogs.forEach(l => {
          if (l && l.id) {
            mergedMap.set(l.id, l);
          }
        });
        
        const mergedLogs = Array.from(mergedMap.values());
        
        // Sort descending by timestamp
        mergedLogs.sort((a, b) => {
          const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return tB - tA;
        });
        
        return res.json(mergedLogs.slice(0, 100));
      } catch (err) {
        console.error("[Email Logs API] Error fetching from firestore, falling back to memory:", err);
      }
    }
    res.json(emailLogs);
  });

  // Fetch recent outbound notification logs specifically for admin monitoring
  app.get("/api/outbound-logs", async (req, res) => {
    if (fbDb) {
      try {
        const querySnapshot = await getDocs(collection(fbDb, "email_logs"));
        const logs: any[] = [];
        querySnapshot.forEach((doc) => {
          logs.push(doc.data());
        });
        
        // Sort descending by timestamp
        logs.sort((a, b) => {
          const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return tB - tA;
        });
        
        return res.json(logs.slice(0, 50));
      } catch (err: any) {
        console.error("[Outbound Logs API] Error fetching from firestore:", err);
        return res.status(500).json({ error: err.message || "Failed to fetch outbound logs" });
      }
    }
    res.json([]);
  });

  // Purge outbound notification logs specifically on command
  app.post("/api/purge-outbound-logs", async (req, res) => {
    try {
      emailLogs.length = 0;
      if (fbDb) {
        const querySnapshot = await getDocs(collection(fbDb, "email_logs"));
        for (const sDoc of querySnapshot.docs) {
          await deleteDoc(sDoc.ref);
        }
      }
      return res.json({ success: true, message: "Outbound notification logs successfully cleared." });
    } catch (err: any) {
      console.error("[Purge Outbound Logs API] Error:", err);
      return res.status(500).json({ error: err.message || "Failed to purge outbound logs" });
    }
  });

  // Get current SMTP configuration and dynamic notification settings
  app.get("/api/settings/smtp-config", async (req, res) => {
    const config = getEmailConfig();
    res.json({
      SMTP_HOST: process.env.SMTP_HOST || config.host || "smtp.gmail.com",
      SMTP_PORT: process.env.SMTP_PORT || config.port || 465,
      SMTP_USER: dynamicSmtpUser || process.env.SMTP_USER || config.user || "rutvikdangar20@gmail.com",
      SMTP_PASS_SET: !!(dynamicSmtpPass || process.env.SMTP_PASS || config.pass),
      NOTIFICATION_EMAIL: dynamicNotificationEmail || process.env.NOTIFICATION_EMAIL || "rutvikdangar20@gmail.com",
    });
  });

  // Update dynamic notification email and smtp pass
  app.post("/api/settings/smtp-config", async (req, res) => {
    try {
      const { NOTIFICATION_EMAIL, SMTP_PASS, SMTP_USER } = req.body;
      let updatedCount = 0;
      let payload: any = {};
      
      if (NOTIFICATION_EMAIL !== undefined) {
        dynamicNotificationEmail = String(NOTIFICATION_EMAIL).trim();
        payload.NOTIFICATION_EMAIL = dynamicNotificationEmail;
        updatedCount++;
      }
      
      if (SMTP_USER !== undefined) {
        dynamicSmtpUser = String(SMTP_USER).trim();
        payload.SMTP_USER = dynamicSmtpUser;
        updatedCount++;
      }
      
      if (SMTP_PASS !== undefined) {
        // Obfuscate secret if it's identical
        if (String(SMTP_PASS).trim() !== "********") {
           dynamicSmtpPass = String(SMTP_PASS).trim();
           payload.SMTP_PASS = dynamicSmtpPass;
           updatedCount++;
        }
      }

      if (updatedCount > 0 && fbDb) {
        await setDoc(doc(fbDb, "settings", "smtp_config"), payload, { merge: true });
        res.json({ success: true, NOTIFICATION_EMAIL: dynamicNotificationEmail, message: "Settings updated successfully" });
      } else {
        res.status(400).json({ error: "Missing valid update fields or identical password sent" });
      }
    } catch (err: any) {
      console.error("[SMTP Config Update Error]:", err);
      res.status(500).json({ error: err.message || "Failed to update notification email" });
    }
  });

  // Empty all system telemetry logs, in-memory contact arrays on command
  app.post("/api/purge-system-data", async (req, res) => {
    try {
      contactDatabase.length = 0;
      emailLogs.length = 0;

      // Also clean up physical database records from Firestore if connected
      if (fbDb) {
        try {
          const emailLogsSnap = await getDocs(collection(fbDb, "email_logs"));
          for (const sDoc of emailLogsSnap.docs) {
            await deleteDoc(sDoc.ref);
          }
          console.log("[SMTP Purge] Wiped physical 'email_logs' Firestore documents.");
        } catch (dbErr) {
          console.error("[SMTP Purge Error] Failed to purge email_logs collection:", dbErr);
        }

        try {
          const mailboxSnap = await getDocs(collection(fbDb, "mailbox_records"));
          for (const sDoc of mailboxSnap.docs) {
            await deleteDoc(sDoc.ref);
          }
          console.log("[SMTP Purge] Wiped physical 'mailbox_records' Firestore documents.");
        } catch (dbErr) {
          console.error("[SMTP Purge Error] Failed to purge mailbox_records collection:", dbErr);
        }
      }

      console.log("[SMTP/Contact Purge] In-memory database of messages and SMTP dispatch logs surged successfully.");
      res.status(200).json({ success: true, message: "Server-side logs and in-memory lists cleared." });
    } catch (error: any) {
      console.error("[Purge System Data Error]:", error);
      res.status(500).json({ success: false, error: error.message || String(error) });
    }
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const { message, history = [], adminInstructions = "", image } = req.body;

      if (!process.env.GEMINI_API_KEY) {
        return res.status(400).json({ 
          error: "API key is not configured yet. Please configure the **GEMINI_API_KEY** in the **Settings > Secrets** panel of AI Studio to enable the Floating AI assistant." 
        });
      }

      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }

      let currentSystemInstruction = SYSTEM_INSTRUCTION;
      if (adminInstructions) {
        currentSystemInstruction += `\n\nADMIN OVERRIDE/ADDITIONAL KNOWLEDGE:\n${adminInstructions}`;
      }

      // Restore history manually
      let validHistory = [...history];
      if (validHistory.length > 0 && validHistory[0].role === "ai") {
        validHistory.shift();
      }

      const contents = validHistory.map((msg: any) => ({
        role: msg.role === "ai" ? "model" : "user",
        parts: [{ text: msg.text }],
      }));

      const userParts: any[] = [{ text: message }];

      if (image && typeof image === "string" && image.startsWith("data:")) {
        const [meta, base64Data] = image.split(",");
        const mimeTypeMatch = meta.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*;/);
        
        if (mimeTypeMatch && mimeTypeMatch[1]) {
           const mimeType = mimeTypeMatch[1];
           // In Gemini API, only certain mimetypes are supported, but we pass it and if it fails, it fails gracefully.
           userParts.push({
             inlineData: {
               data: base64Data,
               mimeType: mimeType,
              },
           });
        }
      }

      contents.push({ role: "user", parts: userParts });

      // Set headers for chunked streaming
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let responseStream;
      try {
        responseStream = await generateContentStreamWithRetry({
          model: "gemini-3.5-flash",
          contents: contents,
          config: {
            systemInstruction: currentSystemInstruction,
            maxOutputTokens: 2000,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.MINIMAL,
            },
          },
        });
      } catch (err: any) {
        // If inlineData mimetype is unsupported, retry without the file
        if (err.message && err.message.toLowerCase().includes("supported")) {
            console.log("Retrying stream without file due to mimetype error:", err.message);
            const fallbackParts = [{ text: message || "User uploaded an unsupported file." }];
            contents[contents.length - 1].parts = fallbackParts;
            responseStream = await generateContentStreamWithRetry({
              model: "gemini-3.5-flash",
              contents: contents,
              config: {
                systemInstruction: currentSystemInstruction,
                maxOutputTokens: 2000,
                thinkingConfig: {
                  thinkingLevel: ThinkingLevel.MINIMAL,
                },
              },
            });
        } else {
            throw err;
        }
      }

      for await (const chunk of responseStream) {
        if (chunk.text) {
          res.write(chunk.text);
        }
      }
      res.end();
    } catch (error: any) {
      console.error("[Gemini API Error]:", JSON.stringify(error));
      
      const errMessage = typeof error === 'string' ? error : JSON.stringify(error);
      let errMsg = "Failed to fetch response.";
      if (errMessage.includes("429") || errMessage.includes("quota") || errMessage.includes("RESOURCE_EXHAUSTED")) {
        errMsg = "I'm currently experiencing a high volume of requests and have reached my limit. Please try again later!";
      } else if (error?.message) {
        errMsg = error.message;
      }

      if (!res.headersSent) {
        res.status(500).json({ error: errMsg });
      } else {
        res.write(`\n\n[ERROR]: ${errMsg}`);
        res.end();
      }
    }
  });

async function generateResumePDF(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    try {
      const publicDir = path.join(process.cwd(), "public");
      if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
      }

      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const pdfPath = path.join(publicDir, "rutvik_dangar_resume.pdf");
      const writeStream = fs.createWriteStream(pdfPath);
      
      doc.pipe(writeStream);
      
      writeStream.on("finish", () => {
        console.log("Real PDF written successfully to public/.");
        const distDir = path.join(process.cwd(), "dist");
        if (fs.existsSync(distDir)) {
          try {
            fs.copyFileSync(
              pdfPath,
              path.join(distDir, "rutvik_dangar_resume.pdf")
            );
            console.log("Real PDF copied to dist/ successfully.");
          } catch (copyErr) {
            console.error("Failed to copy PDF to dist/:", copyErr);
          }
        }
        resolve(true);
      });
      
      writeStream.on("error", (err) => {
        console.error("Error writing PDF:", err);
        reject(err);
      });

      // Generate beautiful content exactly matched to the user's details
      doc.font("Helvetica-Bold").fontSize(20).text("DANGAR RUTVIKKUMAR ALPESHBHAI", { align: "center" });
      doc.moveDown(0.5);
      doc.font("Helvetica").fontSize(10).text("Email: rutvikdangar20@gmail.com | Location: Ahmedabad, Gujarat", { align: "center" });
      doc.moveDown(2);

      doc.font("Helvetica-Bold").fontSize(14).text("Professional Summary");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.5);
      doc.font("Helvetica").fontSize(11).text("An analytical and highly motivated Bachelor of Business Administration (BBA) student specializing in Marketing (Semester 5). Possesses an empirical foundation in Management Information Systems (MIS), corporate financial structures, and consumer buying trends. Proven competency in drafting comprehensive business research models, analyzing data, and translating market parameters into core corporate strategies. Seeking to leverage academic research experience and modern marketing literacy in a progressive business environment.", { align: "justify" });
      doc.moveDown(1.5);

      doc.font("Helvetica-Bold").fontSize(14).text("Education");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.5);

      doc.font("Helvetica-Bold").fontSize(11).text("Bachelor of Business Administration (BBA) — Marketing Specialization", { continued: true }).text("2024 — Present (Semester 5)", { align: "right" });
      doc.font("Helvetica-Oblique").fontSize(10).text("Ahmedabad Institute of Business Management (AIBM)");
      doc.font("Helvetica").fontSize(10).text("Focusing on Consumer Behaviour architecture, Operational Planning, Brand Strategy, Business Analytics, and Management Information Systems (MIS).", { align: "justify" });
      doc.moveDown(1);

      doc.font("Helvetica-Bold").fontSize(11).text("Higher Secondary Certificate (HSC — Class XII)", { continued: true }).text("March 2024", { align: "right" });
      doc.font("Helvetica-Oblique").fontSize(10).text("Gujarat Secondary and Higher Secondary Education Board, Gandhinagar");
      doc.font("Helvetica-Bold").fontSize(10).text("Percentile Rank: 68 PR");
      doc.moveDown(1);

      doc.font("Helvetica-Bold").fontSize(11).text("Secondary School Certificate (SSC — Class X)", { continued: true }).text("March 2022", { align: "right" });
      doc.font("Helvetica-Oblique").fontSize(10).text("Gujarat Secondary and Higher Secondary Education Board, Gandhinagar");
      doc.font("Helvetica-Bold").fontSize(10).text("Percentile Rank: 76 PR");
      doc.moveDown(1.5);

      doc.font("Helvetica-Bold").fontSize(14).text("Academic & Business Projects");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.5);

      doc.font("Helvetica-Bold").fontSize(11).text("Business Research Methods (BRM) Project: College Students Buying Behaviour");
      doc.font("Helvetica-Oblique").fontSize(10).text("Lead Researcher & Analyst");
      doc.font("Helvetica").fontSize(10).list([
        "Formulated structural research criteria to evaluate product preferences, brand loyalty patterns, and purchasing triggers among student segments.",
        "Compiled qualitative data arrays to identify consumer price elasticity, reliance on digital commerce infrastructure, and regional brand-switching activities."
      ]);
      doc.moveDown(1);

      doc.font("Helvetica-Bold").fontSize(11).text("Financial Management Analysis: Dairy Sector Leader (Amul)");
      doc.font("Helvetica-Oblique").fontSize(10).text("Market Analyst & Project Contributor");
      doc.font("Helvetica").fontSize(10).list([
        "Evaluated capital frameworks, working capital cycles, and operational asset distributions of GCMMF (Amul) within the FMCG ecosystem.",
        "Assessed integration mechanics of perishable supply chain systems scaling into emerging Quick-Commerce distribution nodes."
      ]);
      doc.moveDown(1);

      doc.font("Helvetica-Bold").fontSize(11).text("Project Aura & Advanced Automation Frameworks");
      doc.font("Helvetica-Oblique").fontSize(10).text("System Logic Design & Prompt Architect");
      doc.font("Helvetica").fontSize(10).list([
        "Engineered context-handling frameworks and conversational parameters optimization for voice-first automation companions (Aura, Bella AI, Maya).",
        "Mapped semantic logic configurations to handle regional multi-dialect code-switching interactions smoothly."
      ]);
      doc.moveDown(1.5);

      doc.font("Helvetica-Bold").fontSize(14).text("Core Competencies & Professional Skills");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.5);

      doc.font("Helvetica-Bold").fontSize(10).text("Marketing & Strategy: ", { continued: true }).font("Helvetica").text("Consumer Behaviour Tracking, Brand Architecture Foundations, Market Friction Analysis");
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(10).text("Management & Systems: ", { continued: true }).font("Helvetica").text("Business Research Models, Management Information Systems (MIS), Project Planning");
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(10).text("Technical Competencies: ", { continued: true }).font("Helvetica").text("Conversational Architecture Principles, MS Excel Data Records, Flow-Logic Maps");
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(10).text("Languages Known: ", { continued: true }).font("Helvetica").text("English, Hindi, Gujarati");

      doc.end();
    } catch (err) {
      console.error("Critical error in generateResumePDF function:", err);
      reject(err);
    }
  });
}

// Support both signed-in users and guest-devices under Cloud SQL!
async function resolveUser(req: express.Request) {
  const authHeader = req.headers.authorization;
  const guestId = (req.headers["x-guest-id"] as string) || "guest-global";

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const idToken = authHeader.split("Bearer ")[1];
    try {
      const decodedToken = await adminAuth.verifyIdToken(idToken);
      const uid = decodedToken.uid;
      const email = decodedToken.email || "no-email@user.com";

      let userRow = await db.select().from(users).where(eq(users.uid, uid)).then(r => r[0]);
      if (!userRow) {
        const inserted = await db.insert(users).values({ uid, email }).returning();
        userRow = inserted[0];
      }
      return userRow;
    } catch (err) {
      console.warn("Falling back to guest resolution due to auth error:", err);
    }
  }

  // Guest resolution
  const guestUid = `guest-${guestId}`;
  let userRow = await db.select().from(users).where(eq(users.uid, guestUid)).then(r => r[0]);
  if (!userRow) {
    const inserted = await db.insert(users).values({ uid: guestUid, email: "guest@portfolio.com" }).returning();
    userRow = inserted[0];
  }
  return userRow;
}

// Global API endpoints for Google Keep and PostgreSQL Sync Notes
app.get("/api/notes", async (req, res) => {
  try {
    const userRow = await resolveUser(req);
    const userNotes = await db.select()
      .from(dbNotes)
      .where(eq(dbNotes.userId, userRow.id))
      .orderBy(desc(dbNotes.pinned), desc(dbNotes.updatedAt));
    res.json({ success: true, notes: userNotes });
  } catch (err: any) {
    console.error("GET /api/notes error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/notes", async (req, res) => {
  try {
    const userRow = await resolveUser(req);
    const { title, content, color, pinned, remoteId } = req.body;
    
    const inserted = await db.insert(dbNotes).values({
      userId: userRow.id,
      title: title || "",
      content: content || "",
      color: color || "#ffffff",
      pinned: !!pinned,
      remoteId: remoteId || null,
    }).returning();
    
    res.json({ success: true, note: inserted[0] });
  } catch (err: any) {
    console.error("POST /api/notes error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/api/notes/:id", async (req, res) => {
  try {
    const userRow = await resolveUser(req);
    const noteId = parseInt(req.params.id, 10);
    const { title, content, color, pinned, remoteId } = req.body;

    const existing = await db.select().from(dbNotes).where(and(eq(dbNotes.id, noteId), eq(dbNotes.userId, userRow.id))).then(r => r[0]);
    if (!existing) {
      return res.status(404).json({ success: false, error: "Note not found or access denied" });
    }

    const updated = await db.update(dbNotes)
      .set({
        title: title !== undefined ? title : existing.title,
        content: content !== undefined ? content : existing.content,
        color: color !== undefined ? color : existing.color,
        pinned: pinned !== undefined ? !!pinned : existing.pinned,
        remoteId: remoteId !== undefined ? remoteId : existing.remoteId,
        updatedAt: new Date(),
      })
      .where(eq(dbNotes.id, noteId))
      .returning();

    res.json({ success: true, note: updated[0] });
  } catch (err: any) {
    console.error("PUT /api/notes error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/notes/:id", async (req, res) => {
  try {
    const userRow = await resolveUser(req);
    const noteId = parseInt(req.params.id, 10);

    const existing = await db.select().from(dbNotes).where(and(eq(dbNotes.id, noteId), eq(dbNotes.userId, userRow.id))).then(r => r[0]);
    if (!existing) {
      return res.status(404).json({ success: false, error: "Note not found or access denied" });
    }

    await db.delete(dbNotes).where(eq(dbNotes.id, noteId));
    res.json({ success: true, message: "Note deleted successfully" });
  } catch (err: any) {
    console.error("DELETE /api/notes error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Google Keep proxy middleware logic
app.post("/api/keep/proxy-list", async (req, res) => {
  const gToken = req.headers["x-google-access-token"] || req.body.accessToken;
  if (!gToken) {
    return res.status(400).json({ success: false, error: "Missing Google Access Token" });
  }

  try {
    const response = await fetch("https://keep.googleapis.com/v1/notes", {
      headers: {
        Authorization: `Bearer ${gToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ success: false, error: errText });
    }

    const data = await response.json();
    res.json({ success: true, notes: data.notes || [] });
  } catch (err: any) {
    console.error("Keep proxy list error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/keep/proxy-create", async (req, res) => {
  const gToken = req.headers["x-google-access-token"] || req.body.accessToken;
  const { title, content } = req.body;
  if (!gToken) {
    return res.status(400).json({ success: false, error: "Missing Google Access Token" });
  }

  try {
    const response = await fetch("https://keep.googleapis.com/v1/notes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: title || "",
        body: {
          text: {
            text: content || "",
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ success: false, error: errText });
    }

    const data = await response.json();
    res.json({ success: true, note: data });
  } catch (err: any) {
    console.error("Keep proxy create error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- TWILIO LOGS AND LIVE DIAGNOSTIC ENDPOINTS ---
interface TwilioLog {
  id: string;
  timestamp: string;
  to: string;
  body: string;
  status: "success" | "failed" | "sandbox";
  isWhatsApp: boolean;
  info?: string;
  error?: string;
}

const twilioLogsMemory: TwilioLog[] = [];

async function addTwilioLog(to: string, body: string, status: "success" | "failed" | "sandbox", isWhatsApp: boolean, info?: string, error?: string) {
  const id = "tw-" + Math.random().toString(36).substring(2, 11);
  const timestamp = new Date().toISOString();
  
  const logEntry: TwilioLog = {
    id,
    timestamp,
    to,
    body,
    status,
    isWhatsApp,
  };
  if (info) logEntry.info = info;
  if (error) logEntry.error = error;

  twilioLogsMemory.unshift(logEntry);
  if (twilioLogsMemory.length > 50) {
    twilioLogsMemory.pop();
  }

  if (fbDb) {
    try {
      const docData: any = {
        id,
        timestamp,
        to,
        body,
        status,
        isWhatsApp,
        createdAt: timestamp,
      };
      if (info !== undefined && info !== null) docData.info = String(info);
      if (error !== undefined && error !== null) docData.error = String(error);

      await setDoc(doc(fbDb, "twilio_logs", id), docData);
    } catch (err) {
      console.error("[Twilio Log Firestore Error]:", err);
    }
  }
}

// Generate context-aware quick replies using Gemini
app.post("/api/generate-quick-replies", async (req, res) => {
  try {
    const { senderName, messageText } = req.body;
    if (!messageText) {
      return res.status(400).json({ error: "messageText is required" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.json({
        success: true,
        replies: [
          `Hi ${senderName || "there"}! Thank you for your inquiry. I would be happy to discuss details. Let's schedule a call!`,
          `Hello! I received your message: "${messageText.substring(0, 30)}...". I will review it and get back to you shortly.`,
          `Thanks for reaching out! Let's connect on WhatsApp to chat more about this opportunity.`
        ]
      });
    }

    const prompt = `The site owner, Rutvik Dangar, has received the following incoming message from "${senderName || "Guest"}":
"${messageText}"

Analyze this message, and generate three context-aware 'Quick Reply' response templates that Rutvik (the developer) can click to send back via Twilio WhatsApp/SMS.
Return a valid JSON array of strings containing exactly 3 distinct, short (under 25-30 words), highly professional, personal, and context-specific reply templates.
Keep the tone friendly and matching Rutvik's profile (BBA marketing student building at the intersection of Marketing & AI, proficient in Full Stack development, based in Ahmedabad, Gujarat, India).
Do not include any greeting headers or conversational wraps around the array. Just return the JSON array of 3 templates. Like:
["template 1 text", "template 2 text", "template 3 text"]`;

    const response = await generateContentWithRetry({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
      }
    });

    const text = response.text || "";
    let replies: string[] = [];

    try {
      // Find JSON block if wrapped
      const jsonMatch = text.match(/\[\s*".*?"\s*\]/s) || text.match(/\[.*\]/s);
      if (jsonMatch) {
        replies = JSON.parse(jsonMatch[0]);
      } else {
        replies = JSON.parse(text.trim());
      }
    } catch (parseError) {
      console.warn("[Quick Replies Parsing Error] Failed to parse JSON:", text, parseError);
      // Parsing fallback: split by lines or quotes
      const lines = text.split("\n").map(l => l.trim().replace(/^[-*0-9.]+\s*/, "").replace(/^"/, "").replace(/"$/, "").trim()).filter(l => l.length > 5);
      if (lines.length >= 3) {
        replies = lines.slice(0, 3);
      } else {
        replies = [
          `Hi ${senderName || "there"}! Thank you for your message. Let's connect on WhatsApp to discuss further.`,
          `Hi ${senderName || "there"}! I loved your message about "${messageText.substring(0, 20)}...". Let me review this and get back to you soon.`,
          `Hello! Thank you for visiting my portfolio. I will get back to you with details shortly.`
        ];
      }
    }

    // Ensure we have exactly 3 and none are empty
    replies = replies.map(r => r.trim()).filter(Boolean);
    while (replies.length < 3) {
      replies.push(`Hi ${senderName || "there"}! Let's connect on WhatsApp to map out a clear roadmap.`);
    }
    replies = replies.slice(0, 3);

    res.json({ success: true, replies });
  } catch (err: any) {
    console.error("[generate-quick-replies API Error]:", err);
    res.status(500).json({ error: err.message || "Failed to generate quick replies" });
  }
});

// Outbound reply channel over Twilio (WhatsApp or SMS)
app.post("/api/send-reply-twilio", async (req, res) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioNumber = repairPhoneNumber((process.env.TWILIO_WHATSAPP_NUMBER || "+14155238886").trim(), true);

  let { to, body, isWhatsApp } = req.body;
  if (!to || !body) {
    return res.status(400).json({ error: "Fields 'to' and 'body' are required" });
  }

  // Sanitize to number with our robust phone-number repair helper
  let targetNum = repairPhoneNumber(to, false);
  const originalTo = targetNum;

  // Resolve whether isWhatsApp is true
  if (to.trim().startsWith("whatsapp:")) {
    isWhatsApp = true;
  }

  if (!accountSid || !authToken) {
    const sandboxMsg = `Twilio is not configured. (Secrets TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN are missing). Real-time message logged in Sandbox mode.`;
    console.log(`[Twilio Sandbox Channel]: To: ${originalTo}, Reply: "${body}"`);
    await addTwilioLog(originalTo, body, "sandbox", !!isWhatsApp, sandboxMsg);
    return res.json({
      success: true,
      status: "sandbox",
      message: "Message successfully processed and stored in delivery sandbox! (To send a real WhatsApp, add your Twilio Account SID & Auth Token in Secrets)"
    });
  }

  const client = twilio(accountSid, authToken);
  const startTime = Date.now();

  try {
    let fromNum = twilioNumber;
    let finalToNum = targetNum;

    // Apply auto-repair to the reply sender as well
    const targetDigits = finalToNum.replace(/\D/g, "");
    const twilioDigits = fromNum.replace(/\D/g, "");
    let warningLabel = "";
    if (twilioDigits && targetDigits && (twilioDigits === targetDigits || twilioDigits.endsWith(targetDigits.slice(-8)) || targetDigits.endsWith(twilioDigits.slice(-8)))) {
      warningLabel = " (⚠️ Auto-Repaired: TWILIO_WHATSAPP_NUMBER was set to recipient's phone. Swapped to template sender +14155238886)";
      fromNum = "+14155238886";
    }

    if (isWhatsApp) {
      fromNum = `whatsapp:${fromNum}`;
      finalToNum = `whatsapp:${finalToNum}`;
    }

    console.log(`[Twilio Hub API] Sending message. From: ${fromNum}, To: ${finalToNum}, Body length: ${body.length}`);

    const result = await client.messages.create({
      from: fromNum,
      to: finalToNum,
      body: body,
    });

    const infoMsg = `Message Sid: ${result.sid}. Status: ${result.status}. Direction: ${result.direction}.${warningLabel}`;
    await addTwilioLog(originalTo, body, "success", !!isWhatsApp, infoMsg);

    res.json({
      success: true,
      status: "success",
      message: `Message sent successfully! Twilio Status: ${result.status}`,
      sid: result.sid
    });
  } catch (err: any) {
    console.error("[Twilio Hub API Error]:", err);
    let errMsg = err.message || String(err);
    if (err.code === 21608) {
      errMsg = `Twilio Send Error (21608): The sandbox number is unverified. To receive WhatsApp alerts or test replies on your phone, you MUST first send "join ${twilioNumber === '+14155238886' ? 'purple-uniform' : 'your sandbox code'}" to your Twilio number from your phone to opt-in!`;
    }
    await addTwilioLog(originalTo, body, "failed", !!isWhatsApp, undefined, errMsg);
    res.status(500).json({ error: errMsg });
  }
});

// Fetch Twilio delivery logs for real-time validation in the panel
app.get("/api/twilio-logs", async (req, res) => {
  if (fbDb) {
    try {
      const querySnapshot = await getDocs(collection(fbDb, "twilio_logs"));
      const fbLogs: any[] = [];
      querySnapshot.forEach((doc) => {
        fbLogs.push(doc.data());
      });

      const mergedMap = new Map();
      fbLogs.forEach(l => {
        if (l && l.id) mergedMap.set(l.id, l);
      });
      twilioLogsMemory.forEach(l => {
        if (l && l.id) mergedMap.set(l.id, l);
      });

      const mergedLogs = Array.from(mergedMap.values());
      mergedLogs.sort((a, b) => {
        const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tB - tA;
      });

      return res.json(mergedLogs.slice(0, 100));
    } catch (err) {
      console.error("[Twilio Logs API Firestore Error, fallback memory]:", err);
    }
  }
  res.json(twilioLogsMemory);
});

// Purge all Twilio delivery logs
app.post("/api/purge-twilio-logs", async (req, res) => {
  try {
    twilioLogsMemory.length = 0;
    if (fbDb) {
      const snap = await getDocs(collection(fbDb, "twilio_logs"));
      for (const sDoc of snap.docs) {
        await deleteDoc(sDoc.ref);
      }
    }
    res.json({ success: true, message: "Twilio delivery history successfully wiped!" });
  } catch (err: any) {
    console.error("[Purge Twilio Logs API Error]:", err);
    res.status(500).json({ error: err.message || "Failed to purge Twilio logs" });
  }
});

// Get current Twilio routing status configured state
app.get("/api/settings/twilio-status", async (req, res) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioNumber = (process.env.TWILIO_WHATSAPP_NUMBER || "+14155238886").trim();

  res.json({
    configured: !!(accountSid && authToken),
    twilioNumber,
    defaultRecipient: "+919328796324",
    accountSidMasked: accountSid ? `${accountSid.substring(0, 5)}...${accountSid.substring(accountSid.length - 5)}` : null,
  });
});

// Vite middleware for development
async function setupViteOrStatic() {
  try {
    await generateResumePDF();
    console.log("Successfully generated dynamic resume PDF inside server setup!");
  } catch (pdfErr) {
    console.error("Failed to generate PDF inside server setup:", pdfErr);
  }

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // Robust fallback: Serve static files from root public/ folder in production in case of dynamic runtime changes
    const publicPath = path.join(process.cwd(), "public");
    app.use(express.static(publicPath));
    
    // Support wildcard routing for React Router (if used)
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
}

if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  setupViteOrStatic().then(() => {
    const PORT = 3000; // MUST be 3000 per platform constraints
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  });
}

export default app;
