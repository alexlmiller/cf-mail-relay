// Package main is the entry point for the cf-mail-relay SMTP daemon.
//
// MS1 lands the real implementation. This stub exists so the Go module
// is buildable and CI has something to compile.
//
// See IMPLEMENTATION_PLAN.md and relay/README.md for the design.
package main

import (
	"fmt"
	"os"
)

const version = "0.0.0"

func main() {
	fmt.Fprintf(os.Stderr, "cf-mail-relay %s — scaffold only. See IMPLEMENTATION_PLAN.md.\n", version)
	os.Exit(0)
}
