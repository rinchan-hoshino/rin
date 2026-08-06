Feature: Reset a durable chat generation without duplicating visible work
  A chat reset must settle nonterminal delivery state before the next generation starts.

  Scenario: Work not yet dispatched becomes a terminal failure
    Given a claimed interim delivery whose adapter dispatch has not started
    When the chat generation is reset with nonterminal settlement
    Then the chat generation advances exactly once
    And the delivery is failed without an unconfirmed marker

  Scenario: Work already dispatched is retained as unconfirmed delivery
    Given a claimed interim delivery whose adapter dispatch has started
    When the chat generation is reset with nonterminal settlement
    Then the chat generation advances exactly once
    And the delivery is delivered with an unconfirmed marker
