// Limits shared by the page, the RPC contract and the tokenizer. A separate
// module so the page never imports the tokenizer (and Shiki) through them.

/** Text over this size is not a figure's excerpt; it stays plain rather than tying up the server. */
export const MAX_TEXT = 200_000;
