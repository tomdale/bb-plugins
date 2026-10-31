// Text a person or the agent wrote, with `backticked` spans set as inline code
// instead of showing the backticks. For short plain-text previews where a
// full Markdown renderer would be too much.
import { Fragment } from "react";

export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/`([^`\n]+)`/u);
  return (
    <>
      {parts.map((part, index) => (index % 2 === 1 ? <code key={index} className="wt-inline-code">{part}</code> : <Fragment key={index}>{part}</Fragment>))}
    </>
  );
}
