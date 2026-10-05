import nodemailer from 'nodemailer'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'

export async function sendEmail(to: string, subject: string, text: string) {
  if (!env.emailEnabled) {
    return {
      delivered: false,
      message: 'Email delivery is disabled in demo environment.',
    }
  }
  try {
    const transport = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: { user: env.smtpUser, pass: env.smtpPass },
    })
    await transport.sendMail({ from: env.smtpFrom, to, subject, text })
    return { delivered: true, message: 'Email sent.' }
  } catch (error) {
    logger.error('email failed', { error: error instanceof Error ? error.message : 'unknown' })
    return { delivered: false, message: 'Email delivery failed. The report is still available in FinOpsX.' }
  }
}
