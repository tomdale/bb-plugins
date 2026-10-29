import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";

export function syntheticKeys() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Synthetic key invalid");
  return { privateKey, publicKey: `${parsed.type} ${parsed.getPublicSSH().toString("base64")}` };
}
