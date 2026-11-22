//! `ev3-cockpitd`: see the library's `cli` module for the command line and `exit_code` for what
//! the process returns.

use ev3_cockpitd::{cli, exit_code, security, server};

fn main() {
    // Before any DLL could be loaded at run time: System32 only.
    if let Err(error) = security::harden_dll_search() {
        eprintln!("ev3-cockpitd: the DLL search path could not be restricted ({error}).");
        std::process::exit(exit_code::FAILED);
    }
    let options = match cli::parse(std::env::args_os().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("ev3-cockpitd: {message}\n{}", cli::USAGE);
            std::process::exit(exit_code::USAGE);
        }
    };
    std::process::exit(server::run(&options));
}
