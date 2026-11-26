; 4-queens: q_i = row of the queen in column i
(declare-const q1 Int) (declare-const q2 Int) (declare-const q3 Int) (declare-const q4 Int)
(assert (and (<= 1 q1 4) (<= 1 q2 4) (<= 1 q3 4) (<= 1 q4 4)))
(assert (distinct q1 q2 q3 q4))
(assert (distinct (+ q1 1) (+ q2 2) (+ q3 3) (+ q4 4)))
(assert (distinct (- q1 1) (- q2 2) (- q3 3) (- q4 4)))
