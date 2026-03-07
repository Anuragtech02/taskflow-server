import { Resend } from "resend";
import { config } from "../config.js";

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

const FROM_EMAIL = config.emailFrom;
const APP_URL = config.appUrl;

function getEmailTemplate(title: string, content: string, cta?: { text: string; url: string }) {
  const ctaSection = cta
    ? `
      <tr>
        <td align="center" style="padding: 24px 0;">
          <a href="${cta.url}" style="background-color: #6366f1; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
            ${cta.text}
          </a>
        </td>
      </tr>
    `
    : "";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background-color: #f8fafc;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 500px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 24px; border-bottom: 1px solid #e2e8f0;">
              <h1 style="margin: 0; font-size: 20px; font-weight: 600; color: #1e293b;">TaskFlow</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px;">
              <h2 style="margin: 0 0 16px; font-size: 18px; font-weight: 600; color: #1e293b;">${title}</h2>
              <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #475569;">${content}</p>
            </td>
          </tr>
          ${ctaSection}
          <tr>
            <td style="padding: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
              <p style="margin: 0; font-size: 13px; color: #94a3b8;">You're receiving this because you have email notifications enabled.</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: #94a3b8;">
                <a href="${APP_URL}/settings" style="color: #6366f1; text-decoration: none;">Manage preferences</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

function isEmailConfigured(): boolean {
  return resend !== null;
}

export async function sendTaskAssignedEmail(to: string, taskTitle: string, assignedBy: string) {
  if (!isEmailConfigured()) {
    console.log(`[Email] Would send task assigned email to ${to}: "${taskTitle}" assigned by ${assignedBy}`);
    return { success: false, error: "Email not configured" };
  }
  const html = getEmailTemplate("You've been assigned a task", `${assignedBy} assigned you a task: <strong>${taskTitle}</strong>`, { text: "View Task", url: `${APP_URL}/tasks` });
  try {
    const result = await resend!.emails.send({ from: FROM_EMAIL, to, subject: `Task Assigned: ${taskTitle}`, html });
    return { success: true, data: result };
  } catch (error) {
    console.error("[Email] Failed to send task assigned email:", error);
    return { success: false, error };
  }
}

export async function sendTaskDueSoonEmail(to: string, taskTitle: string, dueDate: Date) {
  if (!isEmailConfigured()) {
    console.log(`[Email] Would send due soon email to ${to}: "${taskTitle}" due ${dueDate}`);
    return { success: false, error: "Email not configured" };
  }
  const formattedDate = dueDate.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const html = getEmailTemplate("Task due soon", `Your task <strong>${taskTitle}</strong> is due on ${formattedDate}.`, { text: "View Task", url: `${APP_URL}/tasks` });
  try {
    const result = await resend!.emails.send({ from: FROM_EMAIL, to, subject: `Reminder: "${taskTitle}" is due soon`, html });
    return { success: true, data: result };
  } catch (error) {
    console.error("[Email] Failed to send due soon email:", error);
    return { success: false, error };
  }
}

export async function sendMentionEmail(to: string, taskTitle: string, mentionedBy: string) {
  if (!isEmailConfigured()) {
    console.log(`[Email] Would send mention email to ${to}: "${taskTitle}" mentioned by ${mentionedBy}`);
    return { success: false, error: "Email not configured" };
  }
  const html = getEmailTemplate("You were mentioned", `${mentionedBy} mentioned you in a comment on <strong>${taskTitle}</strong>.`, { text: "View Task", url: `${APP_URL}/tasks` });
  try {
    const result = await resend!.emails.send({ from: FROM_EMAIL, to, subject: `${mentionedBy} mentioned you in "${taskTitle}"`, html });
    return { success: true, data: result };
  } catch (error) {
    console.error("[Email] Failed to send mention email:", error);
    return { success: false, error };
  }
}

export async function sendWelcomeEmail(to: string, userName: string) {
  if (!isEmailConfigured()) {
    console.log(`[Email] Would send welcome email to ${to}: Welcome ${userName}`);
    return { success: false, error: "Email not configured" };
  }
  const html = getEmailTemplate("Welcome to TaskFlow!", `Hi ${userName}, welcome to TaskFlow! Get started by creating your first workspace and inviting your team.`, { text: "Get Started", url: APP_URL });
  try {
    const result = await resend!.emails.send({ from: FROM_EMAIL, to, subject: "Welcome to TaskFlow!", html });
    return { success: true, data: result };
  } catch (error) {
    console.error("[Email] Failed to send welcome email:", error);
    return { success: false, error };
  }
}

export async function sendInviteEmail(to: string, workspaceName: string, invitedBy: string) {
  if (!isEmailConfigured()) {
    console.log(`[Email] Would send invite email to ${to}: invited to ${workspaceName} by ${invitedBy}`);
    return { success: false, error: "Email not configured" };
  }
  const html = getEmailTemplate("You've been invited to a workspace", `${invitedBy} invited you to join <strong>${workspaceName}</strong> on TaskFlow.`, { text: "Join Workspace", url: APP_URL });
  try {
    const result = await resend!.emails.send({ from: FROM_EMAIL, to, subject: `You've been invited to ${workspaceName}`, html });
    return { success: true, data: result };
  } catch (error) {
    console.error("[Email] Failed to send invite email:", error);
    return { success: false, error };
  }
}

export { isEmailConfigured };
