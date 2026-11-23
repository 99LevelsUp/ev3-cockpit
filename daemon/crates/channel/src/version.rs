//! How the daemon and its native clients compare the versions in a hello: a newer release client
//! replaces a release daemon, and `ev3` decides from the same reading whether its own build is
//! newer than the daemon it found.

use std::cmp::Ordering;

/// Compares dotted versions numerically: the first three parts split at `.`, `+` and `-`, each
/// read by its leading digits (none reads as 0, too many digits as the largest number), missing
/// parts as 0. A pre-release or build suffix after the third part is ignored.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    version_parts(a).cmp(&version_parts(b))
}

fn version_parts(version: &str) -> [u64; 3] {
    let mut parts = [0; 3];
    for (slot, part) in parts.iter_mut().zip(version.split(['.', '+', '-'])) {
        *slot = part
            .trim_start()
            .bytes()
            .take_while(u8::is_ascii_digit)
            .fold(0u64, |n, digit| {
                n.saturating_mul(10).saturating_add(u64::from(digit - b'0'))
            });
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically_by_their_first_three_parts() {
        assert_eq!(compare_versions("0.2.552", "0.2.551"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.10", "0.2.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("0.2.6", "0.2.5"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.4", "0.2.5"), Ordering::Less);
        assert_eq!(compare_versions("1.2", "1.2.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.3-beta", "1.2.3+x"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.3-beta.1", "1.2.3"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.3.9", "1.2.3"), Ordering::Equal);
        assert_eq!(
            compare_versions("1.10.0+build", "1.9.99"),
            Ordering::Greater
        );
        assert_eq!(compare_versions("2rc.0.0", "2.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("garbage", "0.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("", "0.0.1"), Ordering::Less);
    }

    #[test]
    fn a_part_too_long_for_a_number_is_the_largest_not_zero() {
        // `ev3` once read it as 0 and the daemon as the largest, so the two disagreed on which
        // build was newer.
        assert_eq!(
            compare_versions("99999999999999999999999.0.0", "1.0.0"),
            Ordering::Greater
        );
        assert_eq!(
            compare_versions("0.2.99999999999999999999999", "0.2.1"),
            Ordering::Greater
        );
    }
}
