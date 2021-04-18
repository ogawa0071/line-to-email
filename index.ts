require("dotenv").config();

// Import all dependencies, mostly using destructuring for better view.
import {
  ClientConfig,
  Client,
  middleware,
  MiddlewareConfig,
  WebhookEvent,
  TextMessage,
  MessageAPIResponseBase,
  Message,
} from "@line/bot-sdk";
import express, { Application, Request, Response } from "express";
import multer from "multer";
import sgMail from "@sendgrid/mail";
import mime from "mime-types";
import fetch from "node-fetch";
import { Storage } from "@google-cloud/storage";
import { v4 as uuidv4 } from "uuid";
import * as mm from "music-metadata";
import FileType from "file-type";

const upload = multer();
sgMail.setApiKey(process.env.SENDGRID_API_KEY || "");
const storage = new Storage({
  credentials: JSON.parse(process.env.GCLOUD_SERVICE_KEY || ""),
});
const bucket = storage.bucket(process.env.GCLOUD_STORAGE_BUCKET || "");

const groupId = process.env.GROUPID || "";
const toEmailString = process.env.TOEMAIL || "";
const toEmailArray = toEmailString.replace(/\s/g, "").split(",");

// Setup all LINE client and Express configurations.
const clientConfig: ClientConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.CHANNEL_SECRET,
};

const middlewareConfig: MiddlewareConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET || "",
};

const PORT = process.env.PORT || 3000;

// Create a new LINE SDK client.
const client = new Client(clientConfig);

// Create a new Express application.
const app: Application = express();

async function getContent(eventMessageId: string) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${eventMessageId}/content`,
    {
      headers: {
        Authorization: `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );

  const fileType = res.headers.get("Content-Type") || "";
  const fileExtname = mime.extension(fileType) || "";
  const file = await res.buffer();

  return {
    fileType,
    fileExtname,
    file,
  };
}

// Function handler to receive the text.
const textEventHandler = async (
  event: WebhookEvent
): Promise<MessageAPIResponseBase | undefined> => {
  // Process all variables here.
  if (event.type !== "message") {
    return;
  }

  console.log(event);

  const msg: sgMail.MailDataRequired = {
    to: toEmailArray,
    from: { email: "line@line-to-email.futa.io", name: "line-to-email" },
    subject: "新着メッセージ",
    text: `${
      event.source.userId
        ? `${(await client.getProfile(event.source.userId)).displayName}さん`
        : "ユーザー"
    }からのメッセージ`,
  };

  switch (event.message.type) {
    case "text":
      msg.text = `${msg.text}

${event.message.text}`;
      break;

    case "image":
    case "video":
    case "audio":
    case "file":
      const { fileType, fileExtname, file } = await getContent(
        event.message.id
      );
      msg.attachments = [
        {
          content: file.toString("base64"),
          type: fileType,
          filename: fileExtname,
        },
      ];

    case "image":
      msg.text = `${msg.text}

画像メッセージ`;
      break;

    case "video":
      msg.text = `${msg.text}

動画メッセージ`;
      break;

    case "audio":
      msg.text = `${msg.text}

音声メッセージ`;
      break;

    case "file":
      msg.text = `${msg.text}

ファイルメッセージ`;
      break;

    case "sticker":
      msg.text = `${msg.text}

スタンプ`;
      break;

    default:
      return;
  }

  console.log(msg);

  await sgMail.send(msg);
};

// Register the LINE middleware.
// As an alternative, you could also pass the middleware in the route handler, which is what is used here.
// app.use(middleware(middlewareConfig));

// Route handler to receive webhook events.
// This route is used to receive connection tests.
app.get(
  "/",
  async (_: Request, res: Response): Promise<Response> => {
    return res.status(200).json({
      status: "success",
      message: "Connected successfully!",
    });
  }
);

// This route is used for the Webhook.
app.post(
  "/webhook",
  middleware(middlewareConfig),
  async (req: Request, res: Response): Promise<Response> => {
    const events: WebhookEvent[] = req.body.events;

    // Process all of the received events asynchronously.
    const results = await Promise.all(
      events.map(async (event: WebhookEvent) => {
        try {
          await textEventHandler(event);
        } catch (err: unknown) {
          if (err instanceof Error) {
            console.error(err);
          }

          // Return an error message.
          return res.status(500).json({
            status: "error",
          });
        }
      })
    );

    // Return a successfull message.
    return res.status(200).json({
      status: "success",
      results,
    });
  }
);

app.post(
  "/email",
  upload.any(),
  async (req: Request, res: Response): Promise<Response> => {
    console.log(req);

    const messageArray: Message[] = [
      {
        type: "text",
        text: `From: ${req.body.from}
Subject: ${req.body.subject}

${req.body.text}`,
      },
    ];

    if (req.files) {
      for (const fileObject of req.files as Express.Multer.File[]) {
        const file = fileObject.buffer;
        const fileType = (await FileType.fromBuffer(file))?.mime;
        const fileName = fileObject.originalname;

        const gcsFile = bucket.file(`line-to-email/${uuidv4()}-${fileName}`);
        await gcsFile.save(file);
        await gcsFile.makePublic();
        const fileUrl = gcsFile.publicUrl();

        switch (fileType) {
          case "image/jpeg":
          case "image/png":
            messageArray.push({
              type: "image",
              originalContentUrl: fileUrl,
              previewImageUrl: fileUrl,
            });
            break;

          case "video/mp4":
          case "video/x-m4v":
            messageArray.push({
              type: "video",
              originalContentUrl: fileUrl,
              previewImageUrl: fileUrl,
            });
            break;

          case "audio/mp4":
          case "audio/x-m4a":
            const metadata = await mm.parseBuffer(file);
            const duration = metadata.format.duration
              ? metadata.format.duration * 1000
              : 0;

            messageArray.push({
              type: "audio",
              originalContentUrl: fileUrl,
              duration,
            });
            break;

          default:
            break;
        }
      }
    }

    console.log(messageArray);

    for (const message of messageArray) {
      await client.pushMessage(groupId, message);
    }

    return res.status(200).json();
  }
);

// Create a server and listen to it.
app.listen(PORT, () => {
  console.log(`Application is live and listening on port ${PORT}`);
});
