// Unless explicitly stated otherwise all files in this repository are licensed under the Apache License, Version 2.0.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2024 Datadog, Inc.

use crate::rule_file::raw_item;
use crate::rule_file::validator::http::RawHttp;

pub(crate) mod http;

raw_item! {
    /// A secret validator and its configuration.
    pub enum RawValidator {
        Http(RawHttp),
    }
}

/// The status of a secret.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum RawSecretStatus {
    Valid,
    Invalid,
    Inconclusive,
}

/// The severity of a validation result.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum RawSeverity {
    Error,
    Warning,
    Notice,
    Info,
}
