// Unless explicitly stated otherwise all files in this repository are licensed under the Apache License, Version 2.0.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2024 Datadog, Inc.

mod check;
mod proximity;
pub mod rule_file;
pub mod scanner;
pub use scanner::{Scanner, ScannerBuilder};
mod validator;

pub use secrets_core as core;
