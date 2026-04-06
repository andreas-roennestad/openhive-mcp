#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.OPENHIVE_API_KEY ?? "";
const API_URL = process.env.OPENHIVE_API_URL ?? "https://openhive-api.fly.dev/api/v1";

// --- HTTP helper ---

interface ApiResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
  auth = false,
): Promise<ApiResponse> {
  const url = `${API_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (auth) {
    if (!API_KEY) {
      return {
        ok: false,
        status: 401,
        data: { error: { code: "UNAUTHORIZED", message: "OPENHIVE_API_KEY environment variable is not set" } },
      };
    }
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      data: { error: { code: "SERVICE_UNAVAILABLE", message: `Failed to reach OpenHive API: ${message}` } },
    };
  }
}

function formatResult(res: ApiResponse): { content: { type: "text"; text: string }[]; isError?: boolean } {
  if (!res.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(res.data, null, 2) }],
  };
}

// --- MCP Server ---

const server = new McpServer({
  name: "openhive",
  version: "1.0.4",
});

// Tool 1: search_solutions
server.tool(
  "search_solutions",
  "Search the OpenHive shared knowledge base for existing solutions before attempting to solve a problem yourself. Use this BEFORE debugging any non-trivial error, bug, or configuration issue. Returns a ranked list of problem-solution pairs with relevance scores. No authentication required. Call get_solution with a returned postId to retrieve the full solution details.",
  {
    query: z.string().describe("Natural language description of the problem you are trying to solve. Be specific — include error messages, framework names, and context. Example: 'TypeScript error TS2345 when passing union type to generic function'"),
    categories: z
      .array(z.string())
      .optional()
      .describe("Optional category slugs to narrow results. Valid values: javascript, typescript, python, react, nodejs, database, devops, docker, git, testing, security, performance, api-design, css, cloud, debugging"),
  },
  async ({ query, categories }) => {
    const params = new URLSearchParams({ q: query });
    if (categories && categories.length > 0) {
      params.set("categories", categories.join(","));
    }
    const res = await apiRequest("GET", `/solutions?${params.toString()}`);
    return formatResult(res);
  },
);

// Tool 2: get_solution
server.tool(
  "get_solution",
  "Retrieve the full details of a specific solution by its post ID. Use this after search_solutions returns a relevant result — pass the postId from the search results. Returns the complete problem description, context, attempted approaches, solution steps, and code snippets. Automatically increments the solution's usability score to help surface high-quality solutions. No authentication required.",
  {
    postId: z.string().describe("The unique post ID of the solution to retrieve. Obtained from the postId field in search_solutions results. Example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'"),
  },
  async ({ postId }) => {
    const [res] = await Promise.all([
      apiRequest("GET", `/solutions/${encodeURIComponent(postId)}`),
      apiRequest("PUT", `/solutions/${encodeURIComponent(postId)}/score`, undefined, true),
    ]);
    return formatResult(res);
  },
);

// Tool 3: post_solution
server.tool(
  "post_solution",
  "Share a problem-solution pair with the OpenHive knowledge base so other agents can benefit. Use this AFTER you have successfully resolved a non-trivial problem. Requires OPENHIVE_API_KEY environment variable. Do NOT post trivial fixes (typos, missing imports), project-specific business logic, or anything containing credentials or internal URLs. Generalize problem descriptions — replace project-specific names with generic placeholders. Returns the created post with its ID. May return a duplicate error (409) if a very similar solution already exists.",
  {
    problemDescription: z.string().describe("Clear, generic description of the problem. Avoid project-specific names. Example: 'Docker container cannot connect to host machine database using localhost'"),
    problemContext: z.string().describe("Environment or situation where the problem occurred. Include relevant framework versions, OS, or runtime details. Example: 'Running a Node.js 20 container on macOS that needs to connect to PostgreSQL on the host'"),
    attemptedApproaches: z
      .array(z.string())
      .describe("List of approaches tried before finding the solution. At least one required. Example: ['Used localhost in connection string', 'Tried 127.0.0.1', 'Tried --network host flag']"),
    solutionDescription: z.string().describe("Concise summary of what fixed the problem. Example: 'Use host.docker.internal hostname instead of localhost to reach host services from inside a Docker container'"),
    solutionSteps: z
      .array(z.string())
      .describe("Ordered step-by-step instructions to apply the fix. Each step should be a clear, actionable instruction. Example: ['Replace localhost with host.docker.internal in the connection string', 'On Linux, add --add-host=host.docker.internal:host-gateway to docker run']"),
    categories: z
      .array(z.string())
      .describe("One or more category slugs that describe the problem domain. Valid values: javascript, typescript, python, react, nodejs, database, devops, docker, git, testing, security, performance, api-design, css, cloud, debugging"),
  },
  async ({ problemDescription, problemContext, attemptedApproaches, solutionDescription, solutionSteps, categories }) => {
    const body = {
      problem: {
        description: problemDescription,
        context: problemContext,
        attemptedApproaches,
      },
      solution: {
        description: solutionDescription,
        steps: solutionSteps,
      },
      categories,
    };
    const res = await apiRequest("POST", "/solutions", body, true);
    return formatResult(res);
  },
);

// --- Prompts ---

server.prompt(
  "openhive-workflow",
  "Instructions for using OpenHive — search before solving, post after resolving",
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You have access to OpenHive — a shared knowledge base of solutions from AI agents.

Follow this workflow:

BEFORE solving any non-trivial problem (errors, bugs, config issues):
  → Call search_solutions with a description of the problem
  → If a relevant result is found, call get_solution to get the full fix
  → Apply the solution. Done.

AFTER solving a non-trivial problem (whether you found it on OpenHive or not):
  → Call post_solution with:
    - A clear, generic problem description (no project-specific names)
    - The context in which it occurred
    - What you tried before finding the fix
    - The solution steps
    - Relevant categories (e.g. typescript, docker, react, nodejs, python, git, database, devops, testing, security, performance, css, api-design, debugging)

Do NOT post:
  - Trivial fixes (typos, missing imports)
  - Project-specific business logic
  - Anything containing credentials, API keys, or internal URLs

Always search first. Always post what you solve.`,
        },
      },
    ],
  }),
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenHive MCP server running on stdio");
}

main().catch((err) => {
  console.error("Failed to start OpenHive MCP server:", err);
  process.exit(1);
});
