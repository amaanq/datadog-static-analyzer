// Unless explicitly stated otherwise all files in this repository are licensed under the Apache License, Version 2.0.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2024 Datadog, Inc.

use crate::Checker;

/// A [`Checker`] that runs a [`CheckData`]'s `candidate` against the underlying PCRE2 regex.
#[derive(Debug, Clone)]
pub struct Regex(pcre2::bytes::Regex);

impl Regex {
    /// Creates a new [`Checker`] from the given [PCRE2 syntax] pattern.
    ///
    /// # Example
    ///
    /// ```rust
    /// # use secrets_core::Checker;
    /// # use crate::secrets_core::checker::Regex;
    /// let regex = Regex::try_new("(?i)abc (?-i)abc").unwrap();
    ///
    /// assert!(regex.check(b"ABC abc"));
    /// assert!(!regex.check(b"ABC ABC"));
    /// ```
    /// [PCRE2 syntax]: https://www.pcre.org/current/doc/html/pcre2syntax.html
    pub fn try_new(pattern: &str) -> Result<Self, pcre2::Error> {
        pcre2::bytes::RegexBuilder::new().build(pattern).map(Self)
    }

    /// Creates a new `Regex`.
    pub fn new(regex: pcre2::bytes::Regex) -> Self {
        Self(regex)
    }
}

impl Checker for Regex {
    /// Checks the input against the underlying regex
    fn check(&self, input: &[u8]) -> bool {
        self.0.is_match(input).unwrap_or(false)
    }
}
