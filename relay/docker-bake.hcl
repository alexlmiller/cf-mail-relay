variable "REGISTRY_IMAGE" {
  default = "ghcr.io/alexlmiller/cf-mail-relay/relay"
}

variable "VERSION" {
  default = "dev"
}

group "default" {
  targets = ["relay"]
}

target "relay" {
  context = "."
  dockerfile = "Dockerfile"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = [
    "${REGISTRY_IMAGE}:${VERSION}",
  ]
}
