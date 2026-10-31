# Using Walkthrough

*Draft guide for the redesigned plugin. It describes the design as decided so far; the wrap-up section is proposed and still open.*

A walkthrough is a change explained to you the way a colleague would explain it: one idea at a time, with the real code beside the words, and room to stop and ask. A helper agent that has read your whole conversation writes it. Your thread keeps working meanwhile.

## When to use it

**You're about to review a pull request.** Ask your thread: "Walk me through PR 1234." You get five short parts instead of a 40-file diff. Flag what bothers you as you read; at the end you have a review draft that points at the exact lines.

**An agent just made a large change in your thread.** Rather than scrolling its summary and then the diff, open a walkthrough of "the changes you just made." You learn what it did and why, and your questions are answered by an agent that was there.

**You inherited a branch.** "Walk me through the changes on this branch, focus on error handling." The walkthrough covers that thread of the change first.

**You want to understand before you approve.** Read, ask "what happens if this fails?", and mark a todo to send back to the agent if the answer isn't good enough.

## Starting

- **From the thread.** Ask for a walkthrough in plain words. The agent opens the pane and writing begins at once.
- **By hand.** Open the Walkthrough panel from the thread's **+** menu. It shows what it found, such as "Uncommitted changes · 4 files" or "PR #1234", with one **Walk me through it** button. Add a focus line if you want ("how the retry works"). Earlier walkthroughs from this thread are listed below.

## Reading

Each walkthrough is a sequence of parts, shown **one at a time**. A part has a title, a few paragraphs of prose, and usually one or two code figures.

- **Pacing.** The agent writes the next part while you read this one, then waits for you. Your questions can shape what it writes next. The part picker shows each part as ready, writing, or not started.
- **Moving.** The bottom bar has **Prev** and **Next**, and **Next** names the part it leads to. The **3 of 5** picker at the top jumps to any ready part.
- **Figures.** The agent chooses what to show. To explain how code works, you see the current code. To explain a change, you see the diff, with a **Diff / After / Before** switch.
- **Numbered markers** in a figure's gutter point to short notes about particular lines. The note text sits in the margin, or under the figure in a narrow panel. The prose may refer to lines ("see L18"); hover one and it lights up.
- **Full page.** Open the walkthrough as a page from the **···** menu for a wider view. It reads the same, with more margin.

## Asking questions

Type in the bar at the bottom: it asks about the part you are on. Above the input are **suggested questions** written with the part, such as "Why is the batch size 100?" Tap one to ask it. After each answer, new follow-ups replace them.

Answers appear in a thread under that part, so they stay with the code they're about. Select a passage or click a line first, and the question is anchored to it.

## Flagging things

Select text or a code line and choose one:

- **Note**, for yourself.
- **Todo**, for the agent to do later.
- **Comment**, a point for the pull request review.
- **Ask**, a question about exactly this.

Everything lands in one list, the **Concerns** sheet, opened from the top bar (a count shows how many are open). Each item shows its part and line. The sheet slides over the margin; the text never moves.

- **Open items** lists everything. Tick **Include in review** to add a comment to the draft. **Send open items to thread** hands your todos and questions to the thread's agent.
- **Review draft** (pull requests) shows the summary and inline comments built from what you included. Edit it by asking in the walkthrough ("drop the third comment"). **Post review…** shows exactly what will be posted. Nothing goes to GitHub until you confirm.

## Deleting a walkthrough

Open the **More** menu and choose **Delete walkthrough…**, or point at a row in the Walkthroughs list and press the trash button. The dialog names the walkthrough and asks first. Deleting removes the walkthrough, your notes and your questions with their answers, and archives the helper thread. Notes you saved to a file stay where they are. There is no undo.

## Staying current

If the code changes after a part was written, that part is marked **out of date** and the agent offers to rewrite it. Code figures are saved when the part is written, so a part still reads correctly if the files are gone; it says so, with the saved copy.

## Finishing *(proposed)*

The last part is a conclusion with a short ledger: open items, questions answered, review state. Its one main action is **Send open items to thread**, or **Post review…** for a PR. You can send items back at any time from the Concerns sheet.

## A good session, start to finish

1. In a thread: "Walk me through PR 1234, I'm worried about the migration."
2. Part 1 appears in about a minute. You read it; part 2 is already being written.
3. In part 2 a diff shows the migration. You select one line: **Comment**, "Not reversible; is that intended?"
4. You tap the suggested question "What happens to existing rows?" and read the answer in the thread under the part.
5. After part 4, you open **Concerns**: two comments, one todo. You tick both comments for review and read the draft.
6. **Post review…**, check the preview, confirm. Send the todo to the thread so the agent can follow up.

## Tips

- Tell the agent your worry up front; it changes the order and weight of the parts.
- Use suggested questions as a prompt for what to doubt, not only what to learn.
- Prefer **Comment** over **Note** whenever the point should survive the review.
