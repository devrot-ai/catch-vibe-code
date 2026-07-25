import { createServerFn } from "@tanstack/react-start";
import { analyzeGithub, parseGithubUrl } from "./detectors/github";
import { analyzeWebsite } from "./detectors/website";
import type { AnalysisResult } from "./detectors/signals";

export const analyzeUrl = createServerFn({ method: "POST" })
  .inputValidator((data: { url: string }) => {
    if (!data || typeof data.url !== "string") throw new Error("url required");
    const trimmed = data.url.trim();
    if (trimmed.length < 4 || trimmed.length > 500) throw new Error("invalid url length");
    return { url: trimmed };
  })
  .handler(async ({ data }): Promise<AnalysisResult> => {
    let url = data.url;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    const gh = parseGithubUrl(url);
    if (gh) return analyzeGithub(gh.owner, gh.repo);
    return analyzeWebsite(url);
  });
