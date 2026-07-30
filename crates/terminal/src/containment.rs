use std::io;

#[cfg(unix)]
#[derive(Debug)]
pub(crate) struct ProcessContainment {
    process_group_id: libc::pid_t,
}

#[cfg(unix)]
impl ProcessContainment {
    pub(crate) fn prepare() -> io::Result<Self> {
        Ok(Self {
            process_group_id: 0,
        })
    }

    pub(crate) fn bind_process_group(&mut self, process_group_id: u32) -> io::Result<()> {
        let process_group_id = libc::pid_t::try_from(process_group_id)
            .map_err(|_| io::Error::other("PTY process group did not fit the platform PID type"))?;
        if process_group_id <= 1 {
            return Err(io::Error::other("PTY process group was not valid"));
        }
        self.process_group_id = process_group_id;
        Ok(())
    }

    pub(crate) fn public_process_group_id(&self) -> Option<u32> {
        u32::try_from(self.process_group_id)
            .ok()
            .filter(|pid| *pid > 1)
    }

    pub(crate) fn terminate(&self) {
        self.signal(libc::SIGHUP);
        self.signal(libc::SIGTERM);
    }

    pub(crate) fn force_kill(&self) {
        self.signal(libc::SIGKILL);
    }

    fn signal(&self, signal: libc::c_int) {
        if self.process_group_id > 1 {
            unsafe {
                libc::kill(-self.process_group_id, signal);
            }
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessContainment {
    fn drop(&mut self) {
        self.force_kill();
    }
}

#[cfg(windows)]
#[derive(Debug)]
pub(crate) struct ProcessContainment {
    _job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ProcessContainment {
    pub(crate) fn prepare() -> io::Result<Self> {
        use std::mem::{size_of, zeroed};
        use std::ptr;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };

        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }

        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const information).cast(),
                u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .expect("job information size fits u32"),
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                CloseHandle(job);
            }
            return Err(error);
        }

        // Retain the only handle until bridge teardown. The spawned ConPTY shell
        // is assigned directly rather than assigning the already-running bridge,
        // which may itself belong to an Electron or CI runner Job.
        Ok(Self { _job: job })
    }

    pub(crate) fn bind_process_handle(
        &mut self,
        process_handle: std::os::windows::io::RawHandle,
    ) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let assigned = unsafe { AssignProcessToJobObject(self._job, process_handle.cast()) };
        if assigned == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn public_process_group_id(&self) -> Option<u32> {
        None
    }

    pub(crate) fn terminate(&self) {
        self.terminate_job();
    }

    pub(crate) fn force_kill(&self) {
        self.terminate_job();
    }

    fn terminate_job(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        unsafe {
            TerminateJobObject(self._job, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessContainment {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;

        self.force_kill();
        unsafe {
            CloseHandle(self._job);
        }
    }
}
