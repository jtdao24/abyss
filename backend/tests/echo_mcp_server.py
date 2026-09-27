"""A tiny stdio MCP server for test_tools.py."""
from mcp.server.mcpserver import MCPServer

server = MCPServer("echo")


@server.tool()
def shout(text: str) -> str:
    """Return the text in capitals."""
    return text.upper()


@server.tool()
def secret() -> str:
    """A tool the allow list hides."""
    return "hidden"


if __name__ == "__main__":
    server.run()
