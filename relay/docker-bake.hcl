variable "REGISTRY_IMAGE" {
  default = "ghcr.io/alexlmiller/cf-mail-relay/relay"
}

variable "VERSION" {
  default = "dev"
}

variable "GIT_SHA" {
  default = "unknown"
}

variable "SOURCE_URL" {
  default = "https://github.com/alexlmiller/cf-mail-relay"
}

group "default" {
  targets = ["relay"]
}

target "relay" {
  context = "."
  dockerfile = "Dockerfile"
  platforms = ["linux/amd64", "linux/arm64"]
  args = {
    VERSION = "${VERSION}"
  }
  annotations = [
    "index:org.opencontainers.image.revision=${GIT_SHA}",
    "index:org.opencontainers.image.source=${SOURCE_URL}",
    "index:org.opencontainers.image.version=${VERSION}",
  ]
  tags = ["${REGISTRY_IMAGE}:${VERSION}"]
}
