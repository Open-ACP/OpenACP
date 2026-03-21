import type { AgentEvent, OutgoingMessage } from "./types.js";
import type { TunnelService } from "../tunnel/tunnel-service.js";
import { extractFileInfo } from "../tunnel/extract-file-info.js";
import { createChildLogger } from "./log.js";

const log = createChildLogger({ module: "message-transformer" });

export class MessageTransformer {
  constructor(private tunnelService?: TunnelService) {}

  transform(
    event: AgentEvent,
    sessionContext?: { id: string; workingDirectory: string },
  ): OutgoingMessage {
    switch (event.type) {
      case "text":
        return { type: "text", text: event.content };
      case "thought":
        return { type: "thought", text: event.content };
      case "tool_call": {
        const metadata: Record<string, unknown> = {
          id: event.id,
          name: event.name,
          kind: event.kind,
          status: event.status,
          content: event.content,
          locations: event.locations,
        };
        this.enrichWithViewerLinks(event, metadata, sessionContext);
        return { type: "tool_call", text: event.name, metadata };
      }
      case "tool_update": {
        const metadata: Record<string, unknown> = {
          id: event.id,
          name: event.name,
          kind: event.kind,
          status: event.status,
          content: event.content,
        };
        this.enrichWithViewerLinks(event, metadata, sessionContext);
        return { type: "tool_update", text: "", metadata };
      }
      case "plan":
        return {
          type: "plan",
          text: "",
          metadata: { entries: event.entries },
        };
      case "usage":
        return {
          type: "usage",
          text: "",
          metadata: {
            tokensUsed: event.tokensUsed,
            contextSize: event.contextSize,
            cost: event.cost,
          },
        };
      case "session_end":
        return { type: "session_end", text: `Done (${event.reason})` };
      case "error":
        return { type: "error", text: event.message };
      default:
        return { type: "text", text: "" };
    }
  }

  private enrichWithViewerLinks(
    event: AgentEvent & { type: "tool_call" | "tool_update" },
    metadata: Record<string, unknown>,
    sessionContext?: { id: string; workingDirectory: string },
  ): void {
    if (!this.tunnelService || !sessionContext) return;

    const name = "name" in event ? event.name || "" : "";
    const kind = "kind" in event ? event.kind : undefined;

    log.debug(
      { name, kind, status: event.status, hasContent: !!event.content },
      "enrichWithViewerLinks: inspecting event",
    );

    const fileInfo = extractFileInfo(
      name,
      kind,
      event.content,
      event.rawInput,
      event.meta,
    );
    if (!fileInfo) return;

    log.info(
      {
        name,
        kind,
        filePath: fileInfo.filePath,
        hasOldContent: !!fileInfo.oldContent,
      },
      "enrichWithViewerLinks: extracted file info",
    );

    const store = this.tunnelService.getStore();
    const viewerLinks: Record<string, string> = {};

    // For edits/writes with diff data (oldText + newText)
    if (fileInfo.oldContent) {
      const id = store.storeDiff(
        sessionContext.id,
        fileInfo.filePath,
        fileInfo.oldContent,
        fileInfo.content,
        sessionContext.workingDirectory,
      );
      if (id) viewerLinks.diff = this.tunnelService.diffUrl(id);
    }

    // Always store as file view (new file creation or read)
    const id = store.storeFile(
      sessionContext.id,
      fileInfo.filePath,
      fileInfo.content,
      sessionContext.workingDirectory,
    );
    if (id) viewerLinks.file = this.tunnelService.fileUrl(id);

    if (Object.keys(viewerLinks).length > 0) {
      metadata.viewerLinks = viewerLinks;
      metadata.viewerFilePath = fileInfo.filePath;
    }
  }
}
