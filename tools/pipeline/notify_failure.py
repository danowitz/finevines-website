#!/usr/bin/env python3
"""Send the production pipeline's independent failure alert."""

from __future__ import annotations

import argparse
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr


SEND_TIMEOUT_SECONDS = 30


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"notify_failure: {name} is required")
    if "\r" in value or "\n" in value:
        raise SystemExit(f"notify_failure: {name} contains a line break")
    return value


def address(name: str) -> tuple[str, str]:
    value = required(name)
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1].strip()
    display, envelope = parseaddr(value)
    if not envelope or "@" not in envelope:
        raise SystemExit(f"notify_failure: {name} is not a valid email address")
    return formataddr((display, envelope)), envelope


def build_message() -> tuple[EmailMessage, str, str]:
    from_header, from_envelope = address("FINEVINES_NOTIFY_FROM")
    to_header, to_envelope = address("FINEVINES_FAILURE_NOTIFY_TO")
    repository = required("GITHUB_REPOSITORY")
    run_id = required("GITHUB_RUN_ID")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1").strip() or "1"
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
    run_url = f"{server}/{repository}/actions/runs/{run_id}"

    workflow = os.environ.get("GITHUB_WORKFLOW", "pipeline")
    event = os.environ.get("GITHUB_EVENT_NAME", "unknown")
    branch = os.environ.get("GITHUB_REF_NAME", "unknown")
    commit = os.environ.get("GITHUB_SHA", "unknown")

    message = EmailMessage()
    message["From"] = from_header
    message["To"] = to_header
    message["Subject"] = (
        f"[FineVines] Production pipeline failed (run {run_id}, attempt {attempt})"
    )
    message.set_content(
        "The FineVines production pipeline failed and needs attention.\n\n"
        f"Workflow: {workflow}\n"
        f"Trigger: {event}\n"
        f"Branch: {branch}\n"
        f"Commit: {commit}\n"
        f"Attempt: {attempt}\n"
        f"Run: {run_url}\n\n"
        "The live website remains on its last successfully deployed version unless "
        "the run failed after its Deploy step. Review the run before retrying it.\n"
    )
    return message, from_envelope, to_envelope


def send(message: EmailMessage, from_envelope: str, to_envelope: str) -> None:
    host = required("FINEVINES_SMTP_HOST")
    user = required("FINEVINES_SMTP_USER")
    password = required("FINEVINES_SMTP_PASS")
    try:
        port = int(required("FINEVINES_SMTP_PORT"))
    except ValueError as error:
        raise SystemExit("notify_failure: FINEVINES_SMTP_PORT must be a number") from error

    tls_context = ssl.create_default_context()
    if port == 465:
        client = smtplib.SMTP_SSL(
            host, port, timeout=SEND_TIMEOUT_SECONDS, context=tls_context
        )
    else:
        client = smtplib.SMTP(host, port, timeout=SEND_TIMEOUT_SECONDS)

    with client:
        if port != 465:
            client.ehlo()
            client.starttls(context=tls_context)
            client.ehlo()
        client.login(user, password)
        client.send_message(
            message, from_addr=from_envelope, to_addrs=[to_envelope]
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run", action="store_true", help="render the alert without contacting SMTP"
    )
    args = parser.parse_args()

    message, from_envelope, to_envelope = build_message()
    if args.dry_run:
        print(message.as_string())
        return

    send(message, from_envelope, to_envelope)
    print(f"notify_failure: alert sent to {to_envelope}")


if __name__ == "__main__":
    main()
