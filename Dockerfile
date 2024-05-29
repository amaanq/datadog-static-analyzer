FROM ubuntu:22.04 AS base

# Rust setup
FROM base AS build
ENV RUSTUP_HOME=/usr/local/rustup \
	CARGO_HOME=/usr/local/cargo \
	PATH=/usr/local/cargo/bin:$PATH

RUN apt-get update && apt-get --no-install-recommends install -y \
	build-essential ca-certificates curl git nodejs npm

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y \
	&& rustup --version \
	&& cargo --version \
	&& rustc --version

RUN npm install -g @datadog/datadog-ci

COPY . /app
WORKDIR /app
RUN cargo build --release --bin datadog-static-analyzer

FROM ubuntu:22.04
COPY --from=build /app/target/release/datadog-static-analyzer /usr/local/bin/datadog-static-analyzer
ENTRYPOINT ["/usr/local/bin/datadog-static-analyzer"]
