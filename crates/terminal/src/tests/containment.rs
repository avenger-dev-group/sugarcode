use super::containment::ProcessContainment;

#[test]
fn windows_process_containment_can_move_to_the_driver_thread() {
    fn assert_send<T: Send>() {}

    assert_send::<ProcessContainment>();
}
