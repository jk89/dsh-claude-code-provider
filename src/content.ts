/**
 * dsh message content → Claude Code input, and handoff transcripts of dsh
 * history Claude did not see (a session that started on, or switched to and
 * back from, another model).
 *
 * @module dsh-claude-code-provider/content
 */

import { readFile } from 'node:fs/promises'
import type { ContentBlock, RequestMessage } from './dsh-types.ts'
import type { ClaudeUserContent } from './session.ts'

/** dsh context injections that only make sense to dsh's own agent. */
const SKIPPED_SOURCES = new Set(['runtime-context', 'repeat-tool-reminder', 'model-selection', 'plan-mode', 'claude-code'])

/** Resolves attachment references to host paths (`ctx.attachments`). */
export interface AttachmentPaths {
  imageHostPath(ref: unknown): string | undefined
  fileHostPath(ref: unknown): string | undefined
}

const TRANSCRIPT_LIMIT = 40_000

/**
 * Plain-text handoff transcript of the dsh history before Claude took over.
 * @param messages - the dsh request history, excluding the pending messages.
 */
export function handoffTranscript(messages: readonly RequestMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const text = blocksText(message.content as readonly ContentBlock[])
    switch (message.role) {
      case 'user': {
        const kind = (message.source as { kind?: string } | undefined)?.kind
        if (kind !== undefined && SKIPPED_SOURCES.has(kind)) break
        if (text.length > 0) lines.push(`User: ${text}`)
        break
      }
      case 'assistant': {
        if (text.length > 0) lines.push(`Assistant: ${text}`)
        for (const block of message.content as readonly ContentBlock[]) {
          if (block.type === 'tool-call') lines.push(`Assistant called tool ${block.name}(${clip(block.arguments, 400)})`)
        }
        break
      }
      case 'tool':
        lines.push(`Tool result: ${clip(text, 1200)}`)
        break
      default:
        break
    }
  }
  let transcript = lines.join('\n\n')
  if (transcript.length > TRANSCRIPT_LIMIT) {
    transcript = `[…earlier part omitted…]\n\n${transcript.slice(-TRANSCRIPT_LIMIT)}`
  }
  return transcript
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function blocksText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Convert dsh user content to Anthropic user content blocks.
 * @param blocks - one dsh user message's content.
 * @param attachments - attachment path resolver, when mounted.
 */
export async function toClaudeContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentPaths | undefined,
): Promise<ClaudeUserContent> {
  const out: ClaudeUserContent = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) out.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const path = attachments?.imageHostPath(block.attachment)
        if (path === undefined || block.offloaded === true) {
          out.push({ type: 'text', text: `[image${path === undefined ? '' : ` saved at ${path}`}]` })
          break
        }
        try {
          const data = (await readFile(path)).toString('base64')
          out.push({
            type: 'image',
            source: { type: 'base64', media_type: block.attachment.mediaType as 'image/png', data },
          })
        } catch {
          out.push({ type: 'text', text: `[image saved at ${path}]` })
        }
        break
      }
      case 'file': {
        const path = attachments?.fileHostPath(block.attachment)
        out.push({
          type: 'text',
          text: `[Attached file "${block.attachment.name}" (${block.attachment.bytes} bytes)${path === undefined ? '' : `, saved at ${path}`}]`,
        })
        break
      }
      default:
        break
    }
  }
  return out
}
