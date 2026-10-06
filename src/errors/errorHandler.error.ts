import { Response } from "express";
import axios from "axios";

export class ErrorHandler {
  private slackWebhookUrl: string;

  constructor(slackWebhookUrl: string) {
    this.slackWebhookUrl = slackWebhookUrl;
  }

  handleHttpError(res: Response, message: string, status: number, error: any) {
    console.error(`[${status}] ${message}`, error.details || "");

    if (this.slackWebhookUrl && status >= 500) {
      this.notifySlack(message, status, error).catch(() => {});
    }

    // El formato sigue siendo { message }; errorCode solo aparece cuando el error lo trae.
    res
      .status(status)
      .json(error?.errorCode ? { message, errorCode: error.errorCode } : { message });
  }

  private async notifySlack(message: string, status: number, error: any) {
    await axios.post(this.slackWebhookUrl, {
      text: `:rotating_light: *Error ${status}*\n>${message}\n\`\`\`${JSON.stringify(error.details || error.stack || "", null, 2)}\`\`\``,
    });
  }
}
