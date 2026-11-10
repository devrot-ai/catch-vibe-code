export type GithubAccess = {
  mode: "authenticated" | "anonymous";
  warning?: string;
};

export function githubAccessStatus(
  hasConnectorCredentials: boolean,
  connectorFailed = false,
): GithubAccess {
  if (hasConnectorCredentials && !connectorFailed) {
    return { mode: "authenticated" };
  }

  return {
    mode: "anonymous",
    warning: connectorFailed
      ? "Authenticated GitHub access failed, so this scan used anonymous access. GitHub’s lower anonymous rate limits may leave some evidence unavailable."
      : "This scan used anonymous GitHub access. GitHub’s lower anonymous rate limits may leave some evidence unavailable.",
  };
}