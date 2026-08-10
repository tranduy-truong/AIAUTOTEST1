import fs from "fs";
import path from "path";
import OpenAI from "openai";
import "dotenv/config";

export class OpenAIAdapter {
  model: string;
  client: OpenAI;

  constructor(modelName: string = "llama-3.3-70b-versatile") {
    this.model = modelName;

    this.client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      dangerouslyAllowBrowser: true,
    });
  }

  async run({
    promptDir,
    workDir,
    timeoutMs,
    maxTokens,
  }: {
    promptDir: string;
    workDir: string;
    timeoutMs: number;
    maxTokens?: number;
  }) {
    try {
      const taskContent = fs.readFileSync(
        path.join(promptDir, "task.md"),
        "utf-8",
      );

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: taskContent }],
        temperature: 0.1,
        max_tokens: maxTokens,
      });

      const output = response.choices[0].message.content || "";
      return { ok: true, rawOutput: output };
    } catch (error: any) {
      console.error("Lỗi AI API:", error);
      return { ok: false, rawOutput: error.message };
    }
  }
}
