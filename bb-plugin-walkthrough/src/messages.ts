// Chat messages the plugin sends on the user's behalf when they act on the
// pause controls. Each message has a short visible line that reads like
// something the user typed ("Next: 2. Storage") and an agent-only part
// carrying the procedure reminder, the group brief, and fresh notes.
import {
  describeNoteForAgent,
  describeNotesForAgent,
  describeOutline,
  finishProcedure,
  formatLocation,
} from "./model.ts";
import type { Note, PauseResponse, Walkthrough } from "./schemas.ts";

export interface AgentMessage {
  visible: string;
  agent: string;
}

/** Every step ends the same way; BB shows only the last message of a turn. */
export const PAUSE_THEN_WRITE =
  "End this step by calling walkthrough_pause, then write the step's content as the final message of your turn with no tool calls after it. BB shows only a turn's last message, and the pause controls open when your turn ends.";

function groupBrief(walkthrough: Walkthrough, index: number): string {
  const group = walkthrough.groups[index]!;
  const lines = [`Group ${index + 1} of ${walkthrough.groups.length}: ${JSON.stringify(group.title)}`];
  if (group.summary) lines.push(`Summary: ${group.summary}`);
  const locations = group.locations.map(formatLocation).filter(Boolean);
  if (locations.length > 0) lines.push(`Locations: ${locations.join(", ")}`);
  return lines.join("\n");
}

function freshNotes(walkthrough: Walkthrough, fresh: Note[]): string | null {
  if (fresh.length === 0) return null;
  return `Notes the user recorded or edited since your last walkthrough call (already saved; do not record them again or investigate them before the finish):\n${fresh
    .map((note) => describeNoteForAgent(walkthrough, note))
    .join("\n")}`;
}

function openQuestions(walkthrough: Walkthrough, notes: Note[]): string | null {
  const open = notes.filter((note) => note.kind === "question" && note.status === "open");
  if (open.length === 0) return null;
  return `Questions already recorded (never offer these as suggestions): ${open.map((note) => JSON.stringify(note.text)).join("; ")}`;
}

/**
 * Agent instructions for the state a walkthrough just moved into. Shared by
 * pause-control messages and walkthrough_advance results.
 */
export function stateInstructions(walkthrough: Walkthrough, notes: Note[], fresh: Note[]): string {
  const parts: string[] = [];
  if (walkthrough.status === "reviewing" && walkthrough.currentGroup !== null) {
    parts.push(
      `Present this group now.\n${groupBrief(walkthrough, walkthrough.currentGroup)}`,
      "Read whatever you still need first. Then call walkthrough_pause with 3-4 useful questions about this group, and write the narration as your final message: prior behavior, the change, and why, with only the relevant snippets and file references; connect earlier groups without spoiling later ones.",
    );
  } else if (walkthrough.status === "finishing") {
    parts.push(
      finishProcedure(walkthrough.mode),
      `Covered groups:\n${describeOutline(walkthrough)}`,
      `All notes:\n${describeNotesForAgent(walkthrough, notes)}`,
    );
  } else if (walkthrough.status === "finished") {
    parts.push("The walkthrough is closed. Act on remaining notes only if the user asks.");
  }
  const recorded = walkthrough.status === "reviewing" ? openQuestions(walkthrough, notes) : null;
  if (recorded) parts.push(recorded);
  const recent = walkthrough.status === "finishing" ? null : freshNotes(walkthrough, fresh);
  if (recent) parts.push(recent);
  return parts.join("\n\n");
}

/**
 * The message for a pause-control choice, given the walkthrough state before
 * (`previous`) and after (`next`) the transition. Returns null when the
 * choice needs no agent turn.
 */
export function pauseChoiceMessage(
  previous: Walkthrough,
  next: Walkthrough,
  response: PauseResponse,
  notes: Note[],
  fresh: Note[],
): AgentMessage | null {
  const header = `[Walkthrough ${next.id}: the user chose this in BB's pause controls.]`;
  switch (response.action) {
    case "complete":
      return null;
    case "ask": {
      const where =
        previous.status === "finishing"
          ? "the finish"
          : previous.currentGroup === null
            ? "the opening"
            : `group ${previous.currentGroup + 1} (${JSON.stringify(previous.groups[previous.currentGroup]!.title)})`;
      const guidance =
        previous.status === "finishing"
          ? "Treat it as the user's direction for the follow-up. When you next stop for input, call walkthrough_pause with follow-up offers, then write your final message."
          : "Answer briefly when it unblocks understanding. For a tangent, suggest recording it as a question. When it depends on a later group, offer to answer now, later, or as a recorded question. Then call walkthrough_pause for the same group (fresh suggestions), and write your answer as the final message.";
      const recent = freshNotes(next, fresh);
      return {
        visible: response.text,
        agent: [`${header} The user asked this during ${where}.`, guidance, recent].filter(Boolean).join("\n\n"),
      };
    }
    case "next":
    case "finish": {
      const visible =
        next.status === "reviewing" && next.currentGroup !== null
          ? `${previous.status === "overview" ? "Start" : "Next"}: ${next.currentGroup + 1}. ${next.groups[next.currentGroup]!.title}`
          : response.action === "finish" && previous.status !== "finishing"
            ? "Finish the walkthrough"
            : "That was the last group. Finish the walkthrough";
      return { visible, agent: `${header}\n\n${stateInstructions(next, notes, fresh)}` };
    }
  }
}
