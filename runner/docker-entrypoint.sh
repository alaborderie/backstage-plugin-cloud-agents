#!/bin/sh
# Accept both `docker run IMAGE doctor` and `docker run IMAGE cloud-agent doctor`.
case "${1:-}" in
  run|doctor|mcp-ask|version|help|--help|-h) set -- cloud-agent "$@" ;;
esac
exec "$@"
