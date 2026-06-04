{
  description = "crm-prism — GitHub-synced Pipedream project (survey taxonomy classification)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          # Tooling the workflows/scripts and skills actually reach for.
          # snowsql is a proprietary Snowflake CLI (not in nixpkgs) and is
          # provided by the host system; same for git/gh on NixOS.
          packages = with pkgs; [
            nodejs_22       # classify-taxonomy + prism-mcpb Node wrapper, @anthropic-ai/sdk
            jq              # curl | jq against Pipedream / Braze REST APIs
            curl            # REST calls in the pipedream-synced-project skill
          ];

          shellHook = ''
            echo "crm-prism dev shell — node $(node --version), $(snowsql --version 2>/dev/null | head -1 || echo 'snowsql: host-provided')"
          '';
        };
      });
}
