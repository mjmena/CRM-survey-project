# PRISM MCP Wrapper

This is a local Model Context Protocol (MCP) server bundled using the official MCPB (MCP Bundle) format. It acts as a bridge between MCP-compatible host applications (like Claude Desktop) and your PRISM Pipedream workflow.

## Installation

This is a `.mcpb` bundle that uses the **Python UV** runtime natively. You don't need to install Python packages manually—simply drop the `.mcpb` file into your MCP client (like Claude Desktop).

When you install this bundle, you will be prompted to provide:
- **Pipedream Access Token**: The Bearer token required to authenticate with the Pipedream workflow.

Once installed, the server will dynamically fetch your tool definitions from Pipedream and route any tool calls securely to the static webhook URL (`https://eombzorv24mjje6.m.pipedream.net`).
