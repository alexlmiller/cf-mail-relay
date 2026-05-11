#!/usr/bin/env python3
"""Disposable SMTP capture server for the MS0 Gmail MIME spike."""

from __future__ import annotations

import argparse
import base64
import os
import re
import socketserver
import ssl
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

MAX_CAPTURE_BYTES = 8 * 1024 * 1024


@dataclass
class ServerConfig:
    host: str
    port: int
    cert: Path
    key: Path
    out_dir: Path
    username: str
    password: str


@dataclass
class Envelope:
    mail_from: str = ""
    recipients: list[str] = field(default_factory=list)


class CaptureHandler(socketserver.StreamRequestHandler):
    envelope: Envelope
    authed: bool
    tls_active: bool

    def setup(self) -> None:
        super().setup()
        self.envelope = Envelope()
        self.authed = False
        self.tls_active = False

    @property
    def config(self) -> ServerConfig:
        return self.server.config  # type: ignore[attr-defined]

    def handle(self) -> None:
        self.write_line("220 cf-mail-relay MS0 capture ESMTP")
        while True:
            raw = self.rfile.readline(MAX_CAPTURE_BYTES)
            if not raw:
                return
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            command, argument = split_command(line)
            if command in {"EHLO", "HELO"}:
                self.handle_ehlo()
            elif command == "STARTTLS":
                self.handle_starttls()
            elif command == "AUTH":
                self.handle_auth(argument)
            elif command == "MAIL":
                self.handle_mail(argument)
            elif command == "RCPT":
                self.handle_rcpt(argument)
            elif command == "DATA":
                self.handle_data()
            elif command == "RSET":
                self.envelope = Envelope()
                self.write_line("250 2.0.0 Ok")
            elif command == "NOOP":
                self.write_line("250 2.0.0 Ok")
            elif command == "QUIT":
                self.write_line("221 2.0.0 Bye")
                return
            else:
                self.write_line("502 5.5.2 Command not implemented")

    def handle_ehlo(self) -> None:
        self.write_line("250-cf-mail-relay-ms0")
        if not self.tls_active:
            self.write_line("250-STARTTLS")
        self.write_line("250-AUTH PLAIN LOGIN")
        self.write_line(f"250 SIZE {MAX_CAPTURE_BYTES}")

    def handle_starttls(self) -> None:
        if self.tls_active:
            self.write_line("503 5.5.1 TLS already active")
            return
        self.write_line("220 2.0.0 Ready to start TLS")
        context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        context.load_cert_chain(self.config.cert, self.config.key)
        tls_socket = context.wrap_socket(self.request, server_side=True)
        self.request = tls_socket
        self.rfile = tls_socket.makefile("rb")
        self.wfile = tls_socket.makefile("wb")
        self.tls_active = True
        self.envelope = Envelope()

    def handle_auth(self, argument: str) -> None:
        if not self.tls_active:
            self.write_line("530 5.7.0 Must issue STARTTLS first")
            return
        mechanism, initial = split_command(argument)
        try:
            if mechanism == "PLAIN":
                username, password = self.auth_plain(initial)
            elif mechanism == "LOGIN":
                username, password = self.auth_login(initial)
            else:
                self.write_line("504 5.5.4 Unsupported AUTH mechanism")
                return
        except ValueError:
            self.write_line("501 5.5.2 Invalid AUTH exchange")
            return

        if username != self.config.username or password != self.config.password:
            self.write_line("535 5.7.8 Authentication credentials invalid")
            return
        self.authed = True
        self.write_line("235 2.7.0 Authentication successful")

    def auth_plain(self, initial: str) -> tuple[str, str]:
        payload = initial
        if payload == "":
            self.write_line("334 ")
            payload = self.read_text_line()
        return parse_auth_plain(payload)

    def auth_login(self, initial: str) -> tuple[str, str]:
        username_payload = initial
        if username_payload == "":
            self.write_line("334 " + b64("Username:"))
            username_payload = self.read_text_line()
        username = base64.b64decode(username_payload, validate=True).decode("utf-8")
        self.write_line("334 " + b64("Password:"))
        password = base64.b64decode(self.read_text_line(), validate=True).decode("utf-8")
        return username, password

    def handle_mail(self, argument: str) -> None:
        if not self.authed:
            self.write_line("530 5.7.0 Authentication required")
            return
        if not argument.upper().startswith("FROM:"):
            self.write_line("501 5.5.2 Syntax: MAIL FROM:<address>")
            return
        self.envelope = Envelope(mail_from=argument[5:].strip())
        self.write_line("250 2.1.0 Sender ok")

    def handle_rcpt(self, argument: str) -> None:
        if self.envelope.mail_from == "":
            self.write_line("503 5.5.1 Need MAIL before RCPT")
            return
        if not argument.upper().startswith("TO:"):
            self.write_line("501 5.5.2 Syntax: RCPT TO:<address>")
            return
        if len(self.envelope.recipients) >= 50:
            self.write_line("452 4.5.3 Too many recipients")
            return
        self.envelope.recipients.append(argument[3:].strip())
        self.write_line("250 2.1.5 Recipient ok")

    def handle_data(self) -> None:
        if len(self.envelope.recipients) == 0:
            self.write_line("503 5.5.1 Need RCPT before DATA")
            return
        self.write_line("354 End data with <CR><LF>.<CR><LF>")
        data = self.read_data_bytes()
        if len(data) > MAX_CAPTURE_BYTES:
            self.write_line("552 5.3.4 Message too large")
            return
        path = write_capture(self.config.out_dir, self.envelope.mail_from, data)
        print(f"captured {len(data)} bytes from {self.envelope.mail_from} to {self.envelope.recipients}: {path}", flush=True)
        self.write_line(f"250 2.0.0 Captured {path.name}")
        self.envelope = Envelope()

    def read_data_bytes(self) -> bytes:
        chunks: list[bytes] = []
        total = 0
        while True:
            line = self.rfile.readline(MAX_CAPTURE_BYTES + 1)
            if line in {b".\r\n", b".\n", b"."}:
                break
            if line.startswith(b".."):
                line = line[1:]
            chunks.append(line)
            total += len(line)
            if total > MAX_CAPTURE_BYTES:
                break
        return b"".join(chunks)

    def read_text_line(self) -> str:
        raw = self.rfile.readline(4096)
        if not raw:
            raise ValueError("missing AUTH line")
        return raw.decode("utf-8").strip()

    def write_line(self, line: str) -> None:
        self.wfile.write(line.encode("utf-8") + b"\r\n")
        self.wfile.flush()


class CaptureServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

    def __init__(self, server_address: tuple[str, int], handler_class: type[CaptureHandler], config: ServerConfig) -> None:
        self.config = config
        super().__init__(server_address, handler_class)


def parse_auth_plain(encoded: str) -> tuple[str, str]:
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
    except Exception as exc:
        raise ValueError("invalid AUTH PLAIN base64") from exc
    parts = decoded.split("\x00")
    if len(parts) != 3:
        raise ValueError("invalid AUTH PLAIN payload")
    return parts[1], parts[2]


def split_command(line: str) -> tuple[str, str]:
    stripped = line.strip()
    if stripped == "":
        return "", ""
    if " " not in stripped:
        return stripped.upper(), ""
    command, argument = stripped.split(" ", 1)
    return command.upper(), argument.strip()


def write_capture(out_dir: Path, mail_from: str, data: bytes) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + sanitize_filename(mail_from) + ".eml"
    path = out_dir / filename
    path.write_bytes(data)
    path.chmod(0o600)
    return path


def sanitize_filename(raw: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", raw.strip("<> "))
    return sanitized or "unknown"


def b64(raw: str) -> str:
    return base64.b64encode(raw.encode("utf-8")).decode("ascii")


def parse_args(argv: list[str]) -> ServerConfig:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=587)
    parser.add_argument("--cert", required=True, type=Path)
    parser.add_argument("--key", required=True, type=Path)
    parser.add_argument("--out", default="/var/lib/cf-mail-relay-ms0/captures", type=Path)
    parser.add_argument("--username", required=True)
    parser.add_argument("--password-env", default="MS0_SMTP_PASSWORD")
    args = parser.parse_args(argv)
    password = os.environ.get(args.password_env, "")
    if password == "":
        raise SystemExit(f"{args.password_env} must be set")
    return ServerConfig(args.host, args.port, args.cert, args.key, args.out, args.username, password)


def main(argv: list[str]) -> int:
    config = parse_args(argv)
    with CaptureServer((config.host, config.port), CaptureHandler, config) as server:
        print(f"MS0 SMTP capture listening on {config.host}:{config.port}; writing to {config.out_dir}", flush=True)
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
