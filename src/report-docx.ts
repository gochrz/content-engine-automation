import {
  Document,
  ExternalHyperlink,
  Packer,
  PageOrientation,
  Paragraph,
  TextRun,
} from "docx";
import type { Config, Script } from "./types.js";
import { formatDate } from "./deliver.js";

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function transcriptExcerpt(transcript: string): string {
  const clean = transcript.trim();
  if (clean.length <= 800) return clean;
  return `${clean.slice(0, 797).trimEnd()}...`;
}

function bodyParagraphs(text: string): Paragraph[] {
  return text
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(
      (part) =>
        new Paragraph({
          children: [new TextRun(part)],
          keepLines: true,
        }),
    );
}

function label(text: string): Paragraph {
  return new Paragraph({
    style: "ReportLabel",
    children: [new TextRun(text.toUpperCase())],
    keepNext: true,
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    style: "ReportHeading2",
    children: [new TextRun(text)],
    keepNext: true,
  });
}

function reportDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function reportFilename(date: Date, timezone: string): string {
  return `Seth Content Scripts - ${reportDate(date, timezone)}.docx`;
}

export async function renderDocxReport(
  scripts: Script[],
  cfg: Config,
  date: Date,
): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      spacing: { before: 0, after: 60 },
      children: [
        new TextRun({
          text: "Seth Content Scripts",
          font: "Arial",
          size: 52,
          color: "000000",
        }),
      ],
    }),
    new Paragraph({
      style: "ReportMetadata",
      children: [
        new TextRun(
          `${scripts.length} ready-to-record scripts · ${formatDate(date, cfg.delivery.timezone)}`,
        ),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun(
          "Each concept includes the adapted script, caption, performance evidence, source transcript, and original Reel link.",
        ),
      ],
    }),
  ];

  scripts.forEach((script, index) => {
    children.push(
      new Paragraph({
        style: "ReportHeading1",
        pageBreakBefore: index > 0,
        keepLines: true,
        keepNext: true,
        children: [new TextRun(`Script ${index + 1}: ${script.topic}`)],
      }),
      label("Hook"),
      new Paragraph({
        style: "ReportHook",
        children: [new TextRun(script.hook)],
        keepLines: true,
      }),
      label("Script"),
      ...bodyParagraphs(script.body),
    );

    if (script.cta) {
      children.push(
        label("Call to action"),
        new Paragraph({
          children: [new TextRun(script.cta)],
          keepLines: true,
        }),
      );
    }

    children.push(
      sectionHeading("Caption"),
      new Paragraph({
        style: "ReportCaptionHook",
        children: [new TextRun(script.captionHook)],
        keepLines: true,
      }),
    );

    if (script.captionBody) {
      children.push(
        new Paragraph({
          children: [new TextRun(script.captionBody)],
          keepLines: true,
        }),
      );
    }

    children.push(
      sectionHeading("Source evidence"),
      new Paragraph({
        style: "ReportSource",
        children: [
          new TextRun(
            `${formatNumber(script.plays)} plays · ${formatNumber(script.likes)} likes · ${formatNumber(script.comments)} comments`,
          ),
        ],
      }),
      new Paragraph({
        style: "ReportSource",
        children: [
          new TextRun(
            `${formatNumber(script.velocityPlaysPerDay)} plays/day · ${(script.engagementRate * 100).toFixed(2)}% engagement`,
          ),
        ],
      }),
      label("Source transcript excerpt"),
      new Paragraph({
        style: "ReportSource",
        children: [new TextRun(transcriptExcerpt(script.transcript))],
      }),
      new Paragraph({
        style: "ReportSourceLink",
        children: [
          new TextRun(`Source: @${script.sourceCreator} · `),
          new ExternalHyperlink({
            link: script.sourceUrl,
            children: [
              new TextRun({
                text: "Open original Reel",
                style: "Hyperlink",
              }),
            ],
          }),
        ],
      }),
    );
  });

  const document = new Document({
    creator: cfg.delivery.fromName,
    title: `${cfg.delivery.subjectPrefix} — ${formatDate(date, cfg.delivery.timezone)}`,
    description: `${scripts.length} ready-to-record scripts for Seth Caslin`,
    styles: {
      default: {
        document: {
          run: {
            font: "Arial",
            size: 22,
            color: "000000",
          },
          paragraph: {
            spacing: {
              before: 0,
              after: 160,
              line: 276,
            },
          },
        },
      },
      paragraphStyles: [
        {
          id: "ReportMetadata",
          name: "Report Metadata",
          basedOn: "Normal",
          next: "Normal",
          run: {
            font: "Arial",
            size: 22,
            color: "555555",
          },
          paragraph: {
            spacing: {
              before: 0,
              after: 160,
              line: 276,
            },
          },
        },
        {
          id: "ReportHeading1",
          name: "Report Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: {
            font: "Arial",
            size: 40,
            color: "000000",
          },
          paragraph: {
            spacing: {
              before: 400,
              after: 120,
            },
          },
        },
        {
          id: "ReportHeading2",
          name: "Report Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: {
            font: "Arial",
            size: 32,
            color: "000000",
          },
          paragraph: {
            spacing: {
              before: 360,
              after: 120,
            },
          },
        },
        {
          id: "ReportLabel",
          name: "Report Label",
          basedOn: "Normal",
          next: "Normal",
          run: {
            font: "Arial",
            size: 18,
            bold: true,
            color: "555555",
          },
          paragraph: {
            spacing: {
              before: 160,
              after: 60,
            },
          },
        },
        {
          id: "ReportHook",
          name: "Report Hook",
          basedOn: "Normal",
          next: "Normal",
          run: {
            font: "Arial",
            size: 26,
            bold: true,
            color: "000000",
          },
          paragraph: {
            spacing: {
              before: 0,
              after: 200,
              line: 300,
            },
          },
        },
        {
          id: "ReportCaptionHook",
          name: "Report Caption Hook",
          basedOn: "Normal",
          next: "Normal",
          run: {
            font: "Arial",
            size: 22,
            bold: true,
            color: "000000",
          },
          paragraph: {
            spacing: {
              before: 0,
              after: 120,
              line: 276,
            },
          },
        },
        {
          id: "ReportSource",
          name: "Report Source",
          basedOn: "Normal",
          next: "Normal",
          run: {
            font: "Arial",
            size: 18,
            color: "555555",
          },
          paragraph: {
            spacing: {
              before: 0,
              after: 80,
              line: 276,
            },
          },
        },
        {
          id: "ReportSourceLink",
          name: "Report Source Link",
          basedOn: "Normal",
          next: "Normal",
          run: {
            font: "Arial",
            size: 18,
            color: "555555",
          },
          paragraph: {
            spacing: {
              before: 80,
              after: 160,
              line: 276,
            },
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: 12240,
              height: 15840,
              orientation: PageOrientation.PORTRAIT,
            },
            margin: {
              top: 1440,
              right: 1440,
              bottom: 1440,
              left: 1440,
              header: 708,
              footer: 708,
              gutter: 0,
            },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(document);
}
