FROM ubuntu:22.04 AS base

FROM base AS build

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV RUSTUP_HOME=/usr/local/rustup \
	CARGO_HOME=/usr/local/cargo   \
	PATH=/usr/local/cargo/bin:$PATH

RUN apt-get update && apt-get --no-install-recommends install -y \
	build-essential ca-certificates curl git

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y \
	&& rustup --version                          \
	&& cargo --version                           \
	&& rustc --version

COPY . /app
WORKDIR /app
RUN cargo build --release --bin datadog-static-analyzer

FROM ubuntu:22.04

COPY --from=build /app/target/release/datadog-static-analyzer /usr/local/bin/datadog-static-analyzer

RUN apt-get update && apt-get --no-install-recommends install -y nodejs npm
RUN npm install -g @datadog/datadog-ci \
	&& datadog-ci --version            \
	&& datadog-static-analyzer --version

ENTRYPOINT ["/bin/bash", "-c"]
CMD ["/usr/local/bin/datadog-static-analyzer"]
